"""全局配置：全部可通过环境变量覆盖，便于 Docker / 生产部署。"""
import os
from datetime import datetime
from zoneinfo import ZoneInfo


class Settings:
    APP_NAME: str = os.getenv("APP_NAME", "Nuon 智造云 · 光疗器械代工一体化平台")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./nuon.db")
    SECRET_KEY: str = os.getenv("SECRET_KEY", "nuon-dev-secret-key-change-me-in-production-0123456789")
    BCRYPT_ROUNDS: int = int(os.getenv("BCRYPT_ROUNDS", "12"))
    TOKEN_EXPIRE_MINUTES: int = int(os.getenv("TOKEN_EXPIRE_MINUTES", "720"))
    TIMEZONE: str = os.getenv("TZ_NAME", "Asia/Shanghai")
    CORS_ORIGINS: list[str] = [o for o in os.getenv("CORS_ORIGINS", "*").split(",") if o]
    # 公司 GS1 厂商识别代码前缀（用于生成 UDI-DI 示例）
    GS1_COMPANY_PREFIX: str = os.getenv("GS1_COMPANY_PREFIX", "697000000")


settings = Settings()


def now() -> datetime:
    """系统时间（工厂本地时区，去掉 tzinfo 存库）。所有记录统一使用此函数取时，保证时间戳由系统生成。"""
    return datetime.now(ZoneInfo(settings.TIMEZONE)).replace(tzinfo=None, microsecond=0)


def today():
    return now().date()
