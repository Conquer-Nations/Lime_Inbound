from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

# Pool tuning matters here. Azure PostgreSQL Flexible Server B1ms caps
# connections at ~50. With 2 uvicorn workers and SQLAlchemy's default
# (pool_size=5, overflow=10), we can blow past that — and once we do,
# every new connect blocks at SSL handshake until something ages out.
#
# What we set and why:
#   - pool_size=4 + max_overflow=4 → ≤8 conns per worker × 2 workers = 16
#     leaves plenty of headroom (Alembic, ad-hoc psql, background tasks).
#   - pool_pre_ping=True → checks each pooled conn with `SELECT 1` before
#     handing it out; a TCP-dead connection (Azure PG transient drop)
#     gets discarded and replaced instead of blowing up the request.
#   - pool_recycle=1800 → recycle conns older than 30 min so we never
#     hold one long enough for the server to silently drop it.
#   - connect_args.timeout=10 → asyncpg's default is 60s, which means a
#     bad pool can stall the entire worker on a single failed connect.
#     10s fails fast and lets the request bubble up a 500 quickly.
engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    pool_size=4,
    max_overflow=4,
    pool_pre_ping=True,
    pool_recycle=1800,
    connect_args={"timeout": 10},
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session
