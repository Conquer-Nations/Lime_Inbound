from __future__ import annotations

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import settings


@pytest_asyncio.fixture
async def db_session():
    """Transaction-isolated async session.

    Anything the test does inside this session — including commits — is rolled
    back at teardown so the seed data stays untouched.
    """
    eng = create_async_engine(settings.database_url, poolclass=NullPool)
    async with eng.connect() as conn:
        trans = await conn.begin()
        await conn.begin_nested()
        session = AsyncSession(
            bind=conn,
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        )
        try:
            yield session
        finally:
            await session.close()
            await trans.rollback()
    await eng.dispose()


@pytest_asyncio.fixture
async def client(db_session):
    """HTTP client that runs against the FastAPI app with `get_session`
    overridden to use the test's transactional session.
    """
    from app.db import get_session
    from app.main import app

    async def _override():
        yield db_session

    app.dependency_overrides[get_session] = _override
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
