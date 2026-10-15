"""
Policy + value network (AlphaZero-style residual tower, trained with supervised learning).

The network takes the compact encoding from encoding.py directly and builds its input planes
internally, so the exported ONNX model needs no feature engineering on the JavaScript side.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

from .encoding import NUM_MOVES

INPUT_PLANES = 12 + 4 + 1  # pieces, castling rights, en passant


class ResidualBlock(nn.Module):
    def __init__(self, channels: int):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(channels)
        self.conv2 = nn.Conv2d(channels, channels, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(channels)
        # Squeeze-and-excitation: lets the block weigh channels using global board context.
        self.se = nn.Sequential(
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(channels, channels // 4),
            nn.ReLU(inplace=True),
            nn.Linear(channels // 4, channels),
            nn.Sigmoid(),
        )

    def forward(self, x):
        y = F.relu(self.bn1(self.conv1(x)), inplace=True)
        y = self.bn2(self.conv2(y))
        y = y * self.se(y)[:, :, None, None]
        return F.relu(x + y, inplace=True)


class ChessNet(nn.Module):
    def __init__(self, channels: int = 128, blocks: int = 10):
        super().__init__()
        self.config = {"channels": channels, "blocks": blocks}
        self.stem = nn.Sequential(
            nn.Conv2d(INPUT_PLANES, channels, 3, padding=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True),
        )
        self.tower = nn.Sequential(*[ResidualBlock(channels) for _ in range(blocks)])
        self.policy_head = nn.Sequential(
            nn.Conv2d(channels, 32, 1, bias=False),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(32 * 64, NUM_MOVES),
        )
        self.value_head = nn.Sequential(
            nn.Conv2d(channels, 8, 1, bias=False),
            nn.BatchNorm2d(8),
            nn.ReLU(inplace=True),
            nn.Flatten(),
            nn.Linear(8 * 64, 128),
            nn.ReLU(inplace=True),
            nn.Linear(128, 3),  # win / draw / loss for the side to move
        )
        self.register_buffer("piece_codes", torch.arange(1, 13).view(1, 1, 12), persistent=False)
        self.register_buffer("square_ids", torch.arange(64).view(1, 64), persistent=False)

    def planes(self, squares, castling, ep):
        n = squares.shape[0]
        # One-hot via comparisons (exports cleanly to ONNX).
        pieces = (squares.long().unsqueeze(-1) == self.piece_codes).float()  # N, 64, 12
        pieces = pieces.permute(0, 2, 1).reshape(n, 12, 8, 8)
        castle = castling.float().view(n, 4, 1, 1).expand(n, 4, 8, 8)
        en_passant = (ep.long().view(n, 1) == self.square_ids).float().view(n, 1, 8, 8)
        return torch.cat([pieces, castle, en_passant], dim=1)

    def forward(self, squares, castling, ep):
        x = self.stem(self.planes(squares, castling, ep))
        x = self.tower(x)
        return self.policy_head(x), self.value_head(x)
