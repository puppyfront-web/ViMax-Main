"""Bridge ViMax Python agents into platform pipeline workers."""
from __future__ import annotations

import logging
import os
import sys
from typing import Any

log = logging.getLogger("vimax-bridge")


def ensure_vimax_path() -> str:
    vimax_root = os.environ.get("VIMAX_ROOT", "/app/vimax")
    if vimax_root not in sys.path:
        sys.path.insert(0, vimax_root)
    return vimax_root


def init_chat_model_from_credential(credential: dict[str, Any]):
    ensure_vimax_path()
    from langchain.chat_models import init_chat_model
    from utils.provider_presets import resolve_chat_model_config

    api_key = (credential.get("api_key") or "").strip()
    if not api_key:
        raise ValueError(
            "Missing LLM api_key in job credential; configure API Key on the default text model in Settings > Models"
        )

    init_args = {
        "model": credential.get("model"),
        # Platform vendors may use custom names (e.g. "deepkey") for
        # OpenAI-compatible endpoints; langchain only accepts its built-in
        # provider names, so any explicit base_url routes through "openai".
        "model_provider": "openai" if credential.get("base_url") else (credential.get("model_provider") or "openai"),
        "api_key": api_key,
        "base_url": credential.get("base_url"),
        "temperature": credential.get("temperature", 0.7),
    }
    if not init_args["model"]:
        raise ValueError(
            "Missing LLM model in job credential; set vendor model id on the default text model in Settings > Models"
        )

    resolved = resolve_chat_model_config(init_args)
    return init_chat_model(**resolved)


def map_canvas_characters(raw_characters: list[dict[str, Any]] | None):
    ensure_vimax_path()
    from interfaces import CharacterInScene

    characters = []
    for index, item in enumerate(raw_characters or []):
        name = (item.get("name") or f"Character{index}").strip()
        description = (item.get("description") or "").strip()
        characters.append(
            CharacterInScene(
                idx=index,
                identifier_in_scene=name,
                is_visible=True,
                static_features=description or f"{name} appears in this scene.",
                dynamic_features="",
            )
        )
    return characters


def shot_brief_to_cell(shot) -> dict[str, Any]:
    audio = getattr(shot, "audio_desc", None) or ""
    return {
        "shotBrief": shot.visual_desc,
        "cameraIdx": shot.cam_idx,
        "ffDesc": "",
        "lfDesc": "",
        "motionDesc": "",
        "audioDesc": audio,
        "shotIdx": shot.idx,
    }


async def design_storyboard_cells(
    content: str,
    credential: dict[str, Any],
    *,
    characters: list[dict[str, Any]] | None = None,
    user_requirement: str | None = None,
) -> list[dict[str, Any]]:
    if not content.strip():
        raise ValueError("Script content is empty")

    ensure_vimax_path()
    from agents import StoryboardArtist

    chat_model = init_chat_model_from_credential(credential)
    artist = StoryboardArtist(chat_model=chat_model)
    mapped_characters = map_canvas_characters(characters)

    storyboard = await artist.design_storyboard(
        script=content,
        characters=mapped_characters,
        user_requirement=user_requirement,
    )
    if not storyboard:
        raise RuntimeError("StoryboardArtist returned no shots")

    return [shot_brief_to_cell(shot) for shot in storyboard]
