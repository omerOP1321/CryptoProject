# Gemini Instruction: Credit-Saving Rules

- **CRITICAL**: Keep all tool calls, file reads, and shell commands to the absolute minimum required.
- Do NOT perform expensive searches or read massive logs/files when the user can provide the information directly.
- Keep all explanations and agent outputs extremely concise and compressed.

---

# Crypto AI Prediction Project Context

## Symbol Checkpoints Parameter Mismatch Fixed
- **LSTM BTC**: standard unidirectional (input_size=14, hidden_size=128)
- **LSTM ETH**: Attention + MLP (input_size=16, hidden_size=64)
- **LSTM XRP**: standard unidirectional (input_size=14, hidden_size=64)
- **TFT ETH**: d_model=16, num_vars=16
- **TFT BTC/XRP**: d_model=64, num_vars=14
- Both `inference_orchestrator.py` and `inference_orchestrator.ipynb` now dynamically detect these hidden sizes and feature shapes.
