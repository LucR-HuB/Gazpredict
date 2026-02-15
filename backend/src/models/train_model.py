import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATASET_PATH = PROJECT_ROOT / "data" / "processed" / "dataset_v2_featured.csv"
MODELS_DIR = PROJECT_ROOT / "data" / "models"
MODEL_PATH = MODELS_DIR / "xgb_gas_v1.json"
MODEL_FEATURES_PATH = MODELS_DIR / "model_features.json"
METRICS_PATH = MODELS_DIR / "metrics.json"

TARGET_COLUMN = "net_injection"
FEATURE_COLUMNS = [
    # Physics
    "hdd",
    "wind_weighted",
    "hdd_wind",
    "cold_weekend",
    # State
    "stock_twh_lag_1",
    "stock_fill_rate",
    # Inertia
    "net_injection_lag_1",
    "net_injection_lag_7",
    "hdd_roll_mean_7",
    "wind_roll_mean_7",
    # Calendar
    "day_sin",
    "day_cos",
    "day_of_week",
    "is_weekend",
]


def train_and_save() -> None:
    logger = logging.getLogger("train_model")
    logger.info("Loading dataset from %s", DATASET_PATH)
    dataset = pd.read_csv(DATASET_PATH)

    required_columns = ["country", TARGET_COLUMN, *FEATURE_COLUMNS]
    missing_columns = [column for column in required_columns if column not in dataset.columns]
    if missing_columns:
        raise KeyError(f"Missing required columns in training dataset: {missing_columns}")

    dataset = dataset[required_columns].replace([np.inf, -np.inf], np.nan).dropna().copy()
    dataset["country"] = dataset["country"].astype(str)
    logger.info("Training rows after cleanup: %s", len(dataset))

    X_raw = dataset[FEATURE_COLUMNS + ["country"]]
    y = dataset[TARGET_COLUMN]

    X = pd.get_dummies(X_raw, columns=["country"], drop_first=False)
    bool_columns = X.select_dtypes(include=["bool"]).columns
    if len(bool_columns) > 0:
        X[bool_columns] = X[bool_columns].astype(int)

    model = XGBRegressor(
        n_estimators=500,
        learning_rate=0.01,
        max_depth=7,
        subsample=0.7,
        colsample_bytree=1.0,
        min_child_weight=1,
        gamma=0.5,
        reg_alpha=0.1,
        reg_lambda=10,
        objective="reg:squarederror",
        random_state=42,
        n_jobs=-1,
        tree_method="hist",
    )

    logger.info("Fitting XGBoost model on full history...")
    model.fit(X, y)
    logger.info("Model training completed.")

    predictions = model.predict(X)
    r2 = r2_score(y, predictions)
    mae = mean_absolute_error(y, predictions)
    rmse = np.sqrt(mean_squared_error(y, predictions))
    abs_y_sum = np.sum(np.abs(y))
    wape = np.sum(np.abs(y - predictions)) / abs_y_sum if abs_y_sum != 0 else 0.0

    metrics = {
        "r2": float(r2),
        "mae": float(mae),
        "rmse": float(rmse),
        "wape": float(wape),
        "training_date": str(pd.Timestamp.now()),
    }

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model.save_model(MODEL_PATH)
    logger.info("Model saved to %s", MODEL_PATH)

    model_features = X.columns.tolist()
    MODEL_FEATURES_PATH.write_text(json.dumps(model_features, indent=2))
    logger.info("Feature order saved to %s", MODEL_FEATURES_PATH)
    logger.info("Number of model features (with dummies): %s", len(model_features))

    METRICS_PATH.write_text(json.dumps(metrics, indent=2))
    logger.info("Model metrics saved to %s", METRICS_PATH)
    logger.info(
        "Model fit metrics | R2=%.6f | MAE=%.6f | RMSE=%.6f | WAPE=%.6f",
        metrics["r2"],
        metrics["mae"],
        metrics["rmse"],
        metrics["wape"],
    )


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    train_and_save()


if __name__ == "__main__":
    main()
