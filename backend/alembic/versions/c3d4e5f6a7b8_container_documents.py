"""container documents table

Revision ID: c3d4e5f6a7b8
Revises: b2c3d4e5f6a7
Create Date: 2026-05-18 16:00:00.000000

Adds `container_documents` for vendor-uploaded photos / scans (driver's
license, insurance, registration, plate photos, dispatch order). One row per
(container, kind); re-upload of the same kind overwrites in place.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c3d4e5f6a7b8'
down_revision: Union[str, Sequence[str], None] = 'b2c3d4e5f6a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'container_documents',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column(
            'container_id',
            sa.Integer(),
            sa.ForeignKey('containers.id'),
            nullable=False,
            index=True,
        ),
        sa.Column('kind', sa.String(length=64), nullable=False, index=True),
        sa.Column('filename', sa.String(length=255), nullable=False),
        sa.Column('content_type', sa.String(length=120), nullable=False),
        sa.Column('file_size', sa.Integer(), nullable=False),
        sa.Column('storage_path', sa.String(length=400), nullable=False),
        sa.Column(
            'uploaded_at',
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column('uploaded_by', sa.String(length=255), nullable=True),
        sa.UniqueConstraint('container_id', 'kind', name='uq_container_doc_kind'),
    )


def downgrade() -> None:
    op.drop_table('container_documents')
