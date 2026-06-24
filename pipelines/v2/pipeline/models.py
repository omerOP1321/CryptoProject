"""
Dual-head models: each outputs (regression of H-step log-return, 3-class logits).
Architectures mirror the production LSTM (attention+MLP) and TFT (VSN+encoder)
so lessons transfer, but with a classification head added.
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F


class _Attention(nn.Module):
    def __init__(self, hidden_dim):
        super().__init__()
        self.attention = nn.Linear(hidden_dim, 1, bias=False)

    def forward(self, lstm_out):
        w = F.softmax(self.attention(lstm_out), dim=1)
        return torch.sum(w * lstm_out, dim=1)


class LSTMDual(nn.Module):
    def __init__(self, input_size, hidden_size=64, num_layers=2, dropout=0.2, n_classes=3):
        super().__init__()
        self.hidden_dim = hidden_size
        self.num_layers = num_layers
        self.lstm = nn.LSTM(input_size, hidden_size, num_layers, batch_first=True,
                            dropout=dropout if num_layers > 1 else 0.0)
        self.attn = _Attention(hidden_size)
        self.shared = nn.Sequential(nn.Linear(hidden_size, hidden_size // 2), nn.ReLU(), nn.Dropout(dropout))
        self.reg_head = nn.Linear(hidden_size // 2, 1)
        self.cls_head = nn.Linear(hidden_size // 2, n_classes)

    def forward(self, x):
        h0 = x.new_zeros(self.num_layers, x.size(0), self.hidden_dim)
        c0 = x.new_zeros(self.num_layers, x.size(0), self.hidden_dim)
        out, _ = self.lstm(x, (h0, c0))
        z = self.shared(self.attn(out))
        return self.reg_head(z).squeeze(-1), self.cls_head(z)


# ---- TFT components (same as production) ----
class _GLU(nn.Module):
    def __init__(self, size):
        super().__init__()
        self.fc = nn.Linear(size, size * 2)

    def forward(self, x):
        a, b = torch.chunk(self.fc(x), 2, dim=-1)
        return a * torch.sigmoid(b)


class _GRN(nn.Module):
    def __init__(self, in_size, hidden, out_size=None, dropout=0.1):
        super().__init__()
        out_size = out_size or in_size
        self.fc1 = nn.Linear(in_size, hidden)
        self.fc2 = nn.Linear(hidden, out_size)
        self.glu = _GLU(out_size)
        self.ln = nn.LayerNorm(out_size)
        self.drop = nn.Dropout(dropout)
        self.skip = nn.Linear(in_size, out_size) if in_size != out_size else nn.Identity()

    def forward(self, x):
        res = self.skip(x)
        x = self.fc2(torch.relu(self.fc1(x)))
        return self.ln(res + self.glu(self.drop(x)))


class _VSN(nn.Module):
    def __init__(self, input_dim, num_vars, d_model, dropout=0.1):
        super().__init__()
        self.num_vars = num_vars
        self.grns = nn.ModuleList([_GRN(input_dim // num_vars, d_model, d_model, dropout)
                                   for _ in range(num_vars)])
        self.selector = _GRN(input_dim, d_model, num_vars, dropout)

    def forward(self, x):
        w = torch.softmax(self.selector(x), dim=-1)
        chunk = x.shape[-1] // self.num_vars
        outs = [self.grns[i](x[..., i * chunk:(i + 1) * chunk]) for i in range(self.num_vars)]
        outs = torch.stack(outs, dim=-1)
        return torch.sum(outs * w.unsqueeze(-2), dim=-1)


class _PosEnc(nn.Module):
    def __init__(self, d_model, max_len=5000):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        pos = torch.arange(0, max_len).unsqueeze(1).float()
        div = torch.exp(torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model))
        pe[:, 0::2] = torch.sin(pos * div)
        pe[:, 1::2] = torch.cos(pos * div)
        self.register_buffer("pe", pe.unsqueeze(0))

    def forward(self, x):
        return x + self.pe[:, :x.size(1), :]


class TFTDual(nn.Module):
    def __init__(self, num_vars, d_model=32, nhead=4, num_layers=2, dropout=0.2, n_classes=3):
        super().__init__()
        self.vsn = _VSN(num_vars, num_vars, d_model, dropout)
        self.pos = _PosEnc(d_model)
        layer = nn.TransformerEncoderLayer(d_model, nhead, d_model * 4, dropout, batch_first=True)
        self.encoder = nn.TransformerEncoder(layer, num_layers)
        self.reg_head = nn.Linear(d_model, 1)
        self.cls_head = nn.Linear(d_model, n_classes)

    def forward(self, x):
        z = self.encoder(self.pos(self.vsn(x)))[:, -1, :]
        return self.reg_head(z).squeeze(-1), self.cls_head(z)
