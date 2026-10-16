from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from honeyforge.infrastructure.models import Audit, Base, StreamEntry, StreamState


class Database:
    def __init__(self, url: str):
        self.engine = create_engine(url, pool_pre_ping=True)
        self.sessions = sessionmaker(self.engine, expire_on_commit=False)

    def unit_of_work(self):
        return UnitOfWork(self.sessions)

    def initialize(self):
        # Test helper only. Production schema is managed by Alembic.
        Base.metadata.create_all(self.engine)
        with self.sessions.begin() as session:
            if not session.get(StreamState, 1):
                session.add(StreamState(id=1, position=0))


class Repository:
    def __init__(self, session):
        self.session = session

    def get(self, model, key, *, lock=False):
        return self.session.get(model, key, with_for_update=lock)

    def find(self, model, **fields):
        return self.session.scalars(select(model).filter_by(**fields)).first()

    def add(self, record):
        self.session.add(record)
        self.session.flush()
        return record

    def list(self, model, *, limit=500, **fields):
        return list(self.session.scalars(select(model).filter_by(**fields)
            .order_by(model.created_at.desc()).limit(limit)))


class UnitOfWork:
    """One atomic command, including its audit record and durable UI notification."""
    def __init__(self, sessions):
        self.sessions = sessions

    def __enter__(self):
        self.session = self.sessions()
        self.transaction = self.session.begin()
        self.repo = Repository(self.session)
        self.stream = None
        return self

    def lock_write(self):
        # Same lock order for every command. Correctness precedes throughput in P0.
        self.stream = self.session.scalars(select(StreamState)
            .where(StreamState.id == 1).with_for_update()).one()

    def emit(self, kind: str, data: dict):
        if self.stream is None:
            self.lock_write()
        self.stream.position += 1
        self.session.add(StreamEntry(position=self.stream.position, kind=kind, data=data))

    def audit(self, actor, action, object_id, details=None):
        self.repo.add(Audit(actor=actor, action=action, object_id=object_id, details=details or {}))

    def __exit__(self, kind, value, traceback):
        try:
            if kind:
                self.transaction.rollback()
            else:
                self.transaction.commit()
        finally:
            self.session.close()
