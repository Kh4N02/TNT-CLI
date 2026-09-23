from slyguy.settings import CommonSettings
from slyguy.settings.types import Bool

from .language import _


class Settings(CommonSettings):
    SYNC_WATCHLIST = Bool('sync_watchlist', _.SYNC_WATCHLIST, default=True)
    ENABLE_CHAPTERS = Bool('enable_chapters', default=False)


settings = Settings()
