"""Reference backend proxy for the EchoNova API (FastAPI).

Apps (browsers, Flutter, mobile) call this proxy with their own user credentials. The proxy
checks the user, applies a quota, adds the EchoNova API key and relays the call. The key stays
on your server.
"""

from .app import create_app
from .config import ConfigError, Settings
from .hooks import InMemoryQuota, Quota, demo_authenticate

__all__ = ["ConfigError", "InMemoryQuota", "Quota", "Settings", "create_app", "demo_authenticate"]
