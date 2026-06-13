# Pipeline v2 – ניסויים ותוצאות

## נקודת התחלה

### Config מקורי

```python
CONFIG = {
    "horizon": 1,
    "seq_length": 60,
    "deadband_k": 0.33,
    "vol_window": 288,

    "batch_size": 128,
    "epochs": 20,
    "patience": 6,
    "lr": 1e-3,
    "weight_decay": 1e-4,
    "cls_loss_weight": 1.0,
    "dropout": 0.2,

    "lstm_hidden": 64,
    "tft_d_model": 32,
    "tft_heads": 4,
    "tft_layers": 2,

    "wf_folds": 2,
    "wf_test_frac": 0.10,
    "wf_val_frac": 0.10,

    "smoke": False,
}
```

---

# ניסוי 1 – LSTM עם הגדרות מקוריות

## Horizon 5 דקות

| Metric          | Value   |
| --------------- | ------- |
| DIR             | 50.9%   |
| p-value         | 0.000   |
| ERR             | 0.0956% |
| Persistence ERR | 0.0891% |
| Net BPS         | -2.0    |
| Real Edge       | NO      |

## Horizon 15 דקות

| Metric          | Value   |
| --------------- | ------- |
| DIR             | 52.0%   |
| p-value         | 0.000   |
| ERR             | 0.1627% |
| Persistence ERR | 0.1551% |
| Net BPS         | -1.9    |
| Real Edge       | NO      |

## Horizon 30 דקות

| Metric          | Value   |
| --------------- | ------- |
| DIR             | 52.3%   |
| p-value         | 0.000   |
| ERR             | 0.2265% |
| Persistence ERR | 0.2185% |
| Net BPS         | -2.1    |
| Real Edge       | NO      |

### מסקנות

* המודל לומד סיגנל אמיתי (p-value=0).
* ה-DIR יציב באזור 51%-52%.
* המודל לא מצליח לנצח Persistence.
* הרווח לאחר עלויות מסחר שלילי.
* אין Real Edge.

---

# ניסוי 2 – שינוי Hyperparameters

בוצעו השינויים:

```python
deadband_k = 0.75
cls_loss_weight = 2.5
wf_folds = 1
```

## Horizon 5 דקות

| Metric    | Value |
| --------- | ----- |
| DIR       | 49.6% |
| Trades    | 2,308 |
| Net BPS   | -2.7  |
| Real Edge | NO    |

## Horizon 15 דקות

| Metric    | Value |
| --------- | ----- |
| DIR       | 51.7% |
| Trades    | 1,065 |
| Net BPS   | -0.9  |
| Real Edge | NO    |

### מסקנות

* העלאת deadband ל-0.75 סיננה כמעט את כל העסקאות.
* כמות העסקאות ירדה מעשרות אלפים לאלפים בודדים.
* הביצועים הידרדרו.
* שינוי זה לא מומלץ.

---

# ניסוי 3 – אימון מהיר

בוצעו השינויים:

```python
epochs = 5
wf_folds = 1
deadband_k = 0.33
cls_loss_weight = 1.0
```

### תוצאה

הביצועים נשארו כמעט זהים.

### מסקנה

* מספר Epochs אינו צוואר הבקבוק.
* המודל מגיע לאותה רמת ביצועים גם באימון קצר.
* סביר שהבעיה אינה באימון אלא באיכות הסיגנל.

---

# ניסוי 4 – TFT

## Horizon 5 דקות

| Metric    | LSTM  | TFT   |
| --------- | ----- | ----- |
| DIR       | 50.9% | 52.5% |
| Net BPS   | -2.0  | -1.8  |
| Real Edge | NO    | NO    |

### מסקנות

* TFT עדיף על LSTM.
* שיפור של כ-1.6% ב-DIR.
* עדיין לא מתקבל Edge מסחרי.
* עדיין מפסיד מול Persistence.
* עדיין Net BPS שלילי.

---

# ניסוי 5 – הגדלת חלון הקלט

בוצע שינוי:

```python
seq_length = 120
```

### תוצאה

האימון הסתיים אך החיזוי קרס:

```text
OutOfMemoryError: CUDA out of memory
Tried to allocate 56.28 GiB
```

### נקודת הקריסה

```python
_predict(model, fold["test"])
```

### מסקנה

הבעיה אינה בהכרח במודל.

סביר שהפונקציה `_predict()` טוענת את כל סט הבדיקה ל-GPU בבת אחת במקום לבצע חיזוי ב-Batches.

נדרש לבדוק את מימוש:

```python
_predict()
```

ולוודא שהוא משתמש ב-DataLoader או Mini-Batches.

---

# מסקנות כוללות

## מה למדנו

* המודל עקבי מאוד.
* קיים סיגנל סטטיסטי אמיתי.
* TFT עדיף על LSTM.
* שינויים ב-deadband וב-loss weights לא יצרו Edge.
* הגדלת מספר Epochs אינה צפויה לפתור את הבעיה.
* ה-DIR תקוע באזור 52%.
* כל המודלים עדיין מפסידים ל-Persistence.
* כל המודלים עדיין מפסידים לאחר עלויות מסחר.

## ההשערה הנוכחית

הבעיה המרכזית אינה:

* Learning Rate
* Epochs
* Hidden Size
* Loss Weights

אלא כנראה:

* Feature Set מוגבל (18 Features בלבד)
* או שהשוק בטווחי 5–60 דקות כמעט יעיל

## צעדים מומלצים

1. לתקן את בעיית ה-OOM ב-`_predict()`.
2. לבדוק TFT עם `seq_length=120`.
3. לבדוק מטבעים נוספים (ETH, SOL וכו').
4. אם גם לאחר מכן הביצועים נשארים סביב 52%, לעבור לשיפור Feature Engineering במקום Hyperparameter Tuning.

---

# 📋 קונבנציית תיעוד ניסויים (Logging Convention)

כל ניסוי חדש מתועד בטבלה אחת לפי הפורמט הקבוע מטה, כדי שאפשר יהיה להשוות ניסויים זה לזה.
מעתיקים את ה-Template, ממלאים, ומוסיפים בתחתית הקובץ.

## חוקי זהב (לפני שמאמינים לתוצאה)
1. **תמיד לאמת על ההיסטוריה המלאה** (`MAX_ROWS = None`) לפני שמסיקים מסקנה. תוצאה על
   `max_rows` קטן (חלון אחרון קצר) היא לרוב מקסם שווא (overfit לרעש) — בדיוק כמו ה-"80%" המקורי.
2. **`p < 0.05` לבד לא מספיק.** עם מאות אלפי דגימות גם 51% יוצא מובהק. מה שקובע אם
   המודל *שמיש* זה: `ERR < persist` **וגם** `net > 0`.
3. **`REAL EDGE: YES`** דורש את שלושתם יחד: `p < 0.05`, `DIR > 50%`, `ERR < persist`.
4. משנים **פרמטר אחד בכל פעם** — אחרת אי אפשר לדעת מה גרם לשינוי.

## משמעות כל מטריקה (Result line)
| Field | Meaning | Good |
|---|---|---|
| `DIR` | Direction accuracy (50% = coin flip) | גבוה ככל האפשר |
| `p` | Binomial p-value מול 50% | < 0.05 = סיגנל אמיתי |
| `ERR` | ‎\|pred − actual\|/actual, ‎% | נמוך |
| `persist` | אותו ERR למודל "אין שינוי" | המודל צריך **לנצח** את זה |
| `net` | רווח ל-trade ב-bps אחרי עלויות | חייב **חיובי** כדי להיות שמיש |

## Template לכל ניסוי (להעתיק)
```
# ניסוי N – <כותרת קצרה>
שינוי מ-baseline: <מה שיניתי, פרמטר אחד>
Config: MODEL=<>, SYMBOL=<>, HORIZON=<>m, FEATURES=<18/26>,
        MAX_ROWS=<>, WF_FOLDS=<>, EPOCHS=<>, SEQ=<>, DEADBAND=<>, CLS_W=<>

| Metric          | Value |
| --------------- | ----- |
| DIR             |       |
| p-value         |       |
| ERR             |       |
| Persistence ERR |       |
| Net BPS         |       |
| Real Edge       |       |

מסקנה: <שורה אחת — האם השינוי עזר/הזיק, והאם להמשיך לכיוון הזה>
```

## רשימת ניסויים מומלצת (לפי הסדר)
> המטרה: למצוא אם יש *בכלל* edge שמנצח עלויות. כל שלב על **ההיסטוריה המלאה**.

1. **Baseline נקי** — TFT, BTC, 5m, 18 features, `MAX_ROWS=None`, `WF_FOLDS=3`. נקודת ייחוס.
2. **Extra features** — אותו דבר עם `USE_EXTRA_FEATURES=True` (26 features). האם `DIR`/`net` עלו?
3. **Horizon sweep** — `[1,3,6,12]` עם הקונפיג הכי טוב עד כה. מחפשים `net > 0`.
4. **Coins** — לחזור על המנצח על ETH/XRP. האם הסיגנל עקבי בין מטבעים?
5. **אם הכל עדיין ~52% ו-`net<0`** → המסקנה היא שהשוק ~יעיל בטווחים האלה. זו מסקנה
   לגיטימית ותקפה לפרויקט (ראו `audit_report.md`), לא כישלון.

---

# תוצאות מלאות (Full-history runs)
> כאן מתעדים הרצות על `MAX_ROWS=None` בלבד (אלה הקובעות). ניסויים על חלון קצן נשארים למעלה כ-exploration.

_(להוסיף כאן את הניסויים לפי ה-Template)_
