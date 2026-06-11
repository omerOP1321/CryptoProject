# Custom AI Subagents for Crypto AI Prediction Project

Welcome! This folder contains definitions, system prompts, and operational guidelines for custom AI subagents specialized in different layers of this codebase. 

Other AI agents (or colleagues using agentic platforms) can load these files to spawn focused, highly-capable subagents for specific tasks.

---

## 👥 Available Subagents

We have defined four specialized subagents tailored to this project's architecture:

| Agent Name | MD File Link | Core Focus |
| :--- | :--- | :--- |
| **Data Engineer Agent** | [data_engineer.md](file:///c:/Users/Lenovo/Documents/CryptoProject/agents/data_engineer.md) | Binance data ingestion, features engineering, scaling, and training sequence windows. |
| **Model Trainer Agent** | [model_trainer.md](file:///c:/Users/Lenovo/Documents/CryptoProject/agents/model_trainer.md) | Neural network definitions, training loops, evaluation metrics (RMSE, Directional Accuracy), and checkpoint management. |
| **Orchestration Agent** | [orchestrator.md](file:///c:/Users/Lenovo/Documents/CryptoProject/agents/orchestrator.md) | Live inference execution, consensus logic, Binance API pagination/rate-limits, and Supabase integration. |
| **Frontend Developer Agent** | [frontend_developer.md](file:///c:/Users/Lenovo/Documents/CryptoProject/agents/frontend_developer.md) | Chart.js visual dashboard customization, local Plotly/ipywidgets GUI styling, and real-time database polling. |

---

## 🛠️ How to Invoke / Spawn Subagents

For agentic frameworks (like Antigravity or Claude Code), you can define and spawn these subagents dynamically. Below is an example structure for defining a subagent using the system prompts found in this directory:

### Example: Antigravity / Gemini CLI definition
```json
{
  "name": "data_engineer",
  "description": "Specialist in historical data fetching, cleaning, feature engineering, and sequence generation.",
  "system_prompt": "<!-- Content of agents/data_engineer.md System Prompt section -->",
  "enable_write_tools": true
}
```
If you are pair-programming manually, you can simply direct your LLM to act as one of these agents by copying the system prompt inside their respective `.md` files.
