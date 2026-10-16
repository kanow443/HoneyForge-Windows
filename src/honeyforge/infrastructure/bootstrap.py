import argparse

from sqlalchemy import select

from honeyforge.infrastructure.database import Database
from honeyforge.infrastructure.models import User
from honeyforge.infrastructure.security import password_hasher
from honeyforge.infrastructure.settings import settings


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["init", "reset-password"])
    args = parser.parse_args()
    if len(settings.admin_password) < 12:
        parser.error("Set HF_ADMIN_PASSWORD to at least 12 characters")
    db = Database(settings.database_url)
    with db.sessions.begin() as session:
        user = session.scalars(select(User).where(User.username == settings.admin_username)).first()
        if not user:
            session.add(User(username=settings.admin_username, password_hash=password_hasher.hash(settings.admin_password)))
            print("Administrator initialized from the configured private credential source.")
        elif args.action == "reset-password":
            user.password_hash = password_hasher.hash(settings.admin_password)
            print("Operator password reset.")
        else:
            print("Operator already exists.")
