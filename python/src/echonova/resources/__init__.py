"""API resources: ``text_to_speech``, ``speech_to_text``, ``sound_cleaning`` and ``widgets``."""

from .sound_cleaning import AsyncCleanJobs, AsyncSoundCleaning, CleanJobs, SoundCleaning
from .speech_to_text import AsyncSpeechToText, AsyncSttJobs, SpeechToText, SttJobs
from .text_to_speech import AsyncTextToSpeech, AsyncTtsJobs, AsyncVoices, TextToSpeech, TtsJobs, Voices
from .widgets import AsyncWidgets, Widgets

__all__ = [
    "AsyncCleanJobs",
    "AsyncSoundCleaning",
    "AsyncSpeechToText",
    "AsyncSttJobs",
    "AsyncTextToSpeech",
    "AsyncTtsJobs",
    "AsyncVoices",
    "AsyncWidgets",
    "CleanJobs",
    "SoundCleaning",
    "SpeechToText",
    "SttJobs",
    "TextToSpeech",
    "TtsJobs",
    "Voices",
    "Widgets",
]
