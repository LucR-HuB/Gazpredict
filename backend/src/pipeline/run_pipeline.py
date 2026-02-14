from __future__ import annotations

import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[3]

PIPELINE_STEPS: list[tuple[str, Path]] = [
    (
        "GIE ETL",
        PROJECT_ROOT / "backend" / "src" / "etl" / "run_gie_daily.py",
    ),
    (
        "Weather ETL",
        PROJECT_ROOT / "backend" / "src" / "etl" / "run_weather_daily.py",
    ),
    (
        "Feature Build",
        PROJECT_ROOT / "backend" / "src" / "features" / "build_features.py",
    ),
    (
        "Model Training",
        PROJECT_ROOT / "backend" / "src" / "models" / "train_model.py",
    ),
    (
        "Inference",
        PROJECT_ROOT / "backend" / "src" / "inference" / "run_inference.py",
    ),
]


def main() -> None:
    total_steps = len(PIPELINE_STEPS)

    for step_index, (step_name, script_path) in enumerate(PIPELINE_STEPS, start=1):
        if not script_path.exists():
            raise FileNotFoundError(f"Pipeline script not found: {script_path}")

        print(
            f">>> [PIPELINE] STEP {step_index}/{total_steps}: Running {step_name}...",
            flush=True,
        )
        subprocess.run(
            [sys.executable, "-u", str(script_path)],
            check=True,
            cwd=PROJECT_ROOT,
        )

    print(
        f">>> [PIPELINE] SUCCESS: All {total_steps} steps completed without errors.",
        flush=True,
    )


if __name__ == "__main__":
    main()
