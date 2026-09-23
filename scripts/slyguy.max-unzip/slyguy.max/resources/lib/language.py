from slyguy.language import BaseLanguage


class Language(BaseLanguage):
    WATCHLIST          = 30000
    SYNC_WATCHLIST     = 30001
    DELETE_WATCHLIST   = 30002
    ADD_WATCHLIST      = 30003
    ADDED_WATCHLIST    = 30004


_ = Language()
