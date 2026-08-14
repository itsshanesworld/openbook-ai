"""Shared Linux storage monitoring and protection."""

from __future__ import annotations

import shutil
from pathlib import Path

BACKEND_DIRECTORY = Path(__file__).resolve().parent.parent
STORAGE_DIRECTORY = BACKEND_DIRECTORY / "data"

WARNING_FREE_SPACE_BYTES = 1024 * 1024 * 1024
RESERVE_FREE_SPACE_BYTES = 256 * 1024 * 1024

MINIMUM_COMPRESSED_EXPORT_BYTES = 2 * 1024 * 1024

STORAGE_DIRECTORY.mkdir(
    parents=True,
    exist_ok=True,
)


class StorageError(RuntimeError):
    """Raised when an operation would violate the storage reserve."""


def get_storage_status() -> dict[str, int | bool]:
    """Return current Linux storage capacity and safety state."""
    usage = shutil.disk_usage(
        STORAGE_DIRECTORY
    )

    return {
        "total_bytes": usage.total,
        "used_bytes": usage.used,
        "free_bytes": usage.free,
        "warning_threshold_bytes": WARNING_FREE_SPACE_BYTES,
        "reserve_bytes": RESERVE_FREE_SPACE_BYTES,
        "low": usage.free < WARNING_FREE_SPACE_BYTES,
        "critical": usage.free < RESERVE_FREE_SPACE_BYTES,
    }


def get_storage_capacity_estimate(
    estimated_output_bytes: int,
) -> dict[str, int | bool]:
    """Return storage safety information for a proposed output."""
    estimated_output_bytes = max(
        int(estimated_output_bytes),
        0,
    )

    status = get_storage_status()

    free_bytes = int(
        status["free_bytes"]
    )

    reserve_bytes = int(
        status["reserve_bytes"]
    )

    required_free_bytes = (
        estimated_output_bytes
        + reserve_bytes
    )

    projected_free_bytes = max(
        free_bytes
        - estimated_output_bytes,
        0,
    )

    return {
        **status,
        "estimated_output_bytes": estimated_output_bytes,
        "required_free_bytes": required_free_bytes,
        "projected_free_bytes": projected_free_bytes,
        "safe": free_bytes >= required_free_bytes,
    }


def ensure_storage_capacity(
    estimated_output_bytes: int,
    *,
    operation: str,
) -> None:
    """Ensure an operation leaves the protected free-space reserve."""
    capacity = get_storage_capacity_estimate(
        estimated_output_bytes
    )

    if bool(capacity["safe"]):
        return

    free_bytes = int(
        capacity["free_bytes"]
    )

    output_bytes = int(
        capacity["estimated_output_bytes"]
    )

    reserve_bytes = int(
        capacity["reserve_bytes"]
    )

    required_free_bytes = int(
        capacity["required_free_bytes"]
    )

    free_mb = bytes_to_megabytes(
        free_bytes
    )

    output_mb = bytes_to_megabytes(
        output_bytes
    )

    reserve_mb = bytes_to_megabytes(
        reserve_bytes
    )

    required_mb = bytes_to_megabytes(
        required_free_bytes
    )

    raise StorageError(
        f"Not enough Linux storage for {operation}. "
        f"The operation is estimated to need about "
        f"{output_mb} MB and OpenBook AI protects a "
        f"{reserve_mb} MB safety reserve. "
        f"About {required_mb} MB free is required, "
        f"but only {free_mb} MB is available."
    )


def estimate_compressed_export_size(
    source_path: Path,
) -> int:
    """Estimate a 64 kbps compressed export from a WAV source."""
    source_size = source_path.stat().st_size

    return max(
        MINIMUM_COMPRESSED_EXPORT_BYTES,
        source_size // 10,
    )


def bytes_to_megabytes(
    value: int,
) -> int:
    """Convert bytes to rounded megabytes."""
    return round(
        value / 1024 / 1024
    )
