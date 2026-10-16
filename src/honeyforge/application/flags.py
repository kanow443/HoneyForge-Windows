"""Analyst event markers and scoped training flags placed by honeytokens."""
import secrets

from sqlalchemy import func, select

from honeyforge.domain.errors import DomainError
from honeyforge.infrastructure.models import (
    Deployment,
    Event,
    EventFlag,
    FlagChallenge,
    FlagSolve,
    HoneyToken,
    HoneyTokenBinding,
    User,
    now,
)
from honeyforge.infrastructure.projections import event_view, record


class FlagService:
    def __init__(self, database):
        self.database = database

    def set_event_flag(self, actor, event_id, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            event = u.repo.get(Event, event_id)
            if event is None:
                raise DomainError("not_found", "Event was not found", 404)
            row = u.repo.find(EventFlag, event_id=event_id, flag=command.flag)
            if command.enabled:
                if row is None:
                    row = u.repo.add(EventFlag(event_id=event_id, flag=command.flag,
                        note=command.note, created_by=actor))
                elif row.note != command.note:
                    row.note, row.created_by, row.created_at = command.note, actor, now()
                else:
                    return event_view(u.session, event)
            elif row is not None:
                u.session.delete(row)
                u.session.flush()
            else:
                return event_view(u.session, event)
            u.audit(actor, "event.flag.set" if command.enabled else "event.flag.removed", event_id,
                {"flag": command.flag, "note": command.note if command.enabled else ""})
            u.emit("event.flag.changed", {"id": event_id})
            return event_view(u.session, event)

    def create_challenge(self, actor, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            binding = u.repo.get(HoneyTokenBinding, str(command.binding_id))
            if binding is None:
                raise DomainError("not_found", "Honeytoken binding was not found", 404)
            token = u.repo.get(HoneyToken, binding.token_id)
            deployment = u.repo.get(Deployment, binding.deployment_id)
            if (token.revoked_at or deployment.runtime_generation != binding.generation or
                    deployment.desired_state != "running" or deployment.observed_state != "running"):
                raise DomainError("stale_binding", "Publish an active honeytoken in a running trap first", 409)
            if u.repo.find(FlagChallenge, binding_id=binding.id):
                raise DomainError("challenge_exists", "This binding already has a challenge", 409)
            row = u.repo.add(FlagChallenge(binding_id=binding.id, title=command.title,
                points=command.points, created_by=actor))
            u.audit(actor, "flag.challenge.created", row.id, {"binding_id": binding.id, "points": row.points})
            u.emit("flag.challenge.changed", {"id": row.id})
            return self._view(u.session, row, admin=True)

    def set_challenge(self, actor, challenge_id, enabled):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = u.repo.get(FlagChallenge, challenge_id)
            if row is None:
                raise DomainError("not_found", "Challenge was not found", 404)
            if row.enabled != enabled:
                row.enabled = enabled
                u.audit(actor, "flag.challenge.enabled" if enabled else "flag.challenge.disabled", row.id)
                u.emit("flag.challenge.changed", {"id": row.id})
            return self._view(u.session, row, admin=True)

    def challenges(self, user_id, admin=False):
        with self.database.sessions() as s:
            rows = s.scalars(select(FlagChallenge).order_by(FlagChallenge.created_at.desc()).limit(200))
            return [self._view(s, row, user_id=user_id, admin=admin) for row in rows if admin or self._active(s, row)]

    def submit(self, user_id, command):
        with self.database.unit_of_work() as u:
            u.lock_write()
            row = u.repo.get(FlagChallenge, str(command.challenge_id))
            if row is None or not self._active(u.session, row):
                raise DomainError("challenge_unavailable", "Challenge is unavailable", 404)
            if u.repo.find(FlagSolve, challenge_id=row.id, user_id=user_id):
                raise DomainError("already_solved", "Your team already solved this challenge", 409)
            binding = u.repo.get(HoneyTokenBinding, row.binding_id)
            expected = "HF{" + binding.public_value + "}"
            if not secrets.compare_digest(command.flag, expected):
                raise DomainError("invalid_flag", "Flag is incorrect", 400)
            solve = u.repo.add(FlagSolve(challenge_id=row.id, user_id=user_id, points=row.points))
            user = u.repo.get(User, user_id)
            u.audit(user.username, "flag.solved", solve.id, {"challenge_id": row.id, "points": solve.points})
            u.emit("flag.solved", {"challenge_id": row.id, "user_id": user_id})
            return {"ok": True, "points": solve.points, "challenge_id": row.id}

    def scoreboard(self):
        with self.database.sessions() as s:
            rows = s.execute(select(User.username, func.sum(FlagSolve.points), func.count(FlagSolve.id))
                .join(FlagSolve, FlagSolve.user_id == User.id).group_by(User.id, User.username)
                .order_by(func.sum(FlagSolve.points).desc(), User.username).limit(100)).all()
            return [{"username": name, "points": points, "solves": solves} for name, points, solves in rows]

    @staticmethod
    def _active(s, challenge):
        binding = s.get(HoneyTokenBinding, challenge.binding_id)
        token = s.get(HoneyToken, binding.token_id)
        deployment = s.get(Deployment, binding.deployment_id)
        return bool(challenge.enabled and token.revoked_at is None and
            deployment.runtime_generation == binding.generation and deployment.desired_state == "running" and
            deployment.observed_state == "running")

    def _view(self, s, row, user_id=None, admin=False):
        result = record(row, {"binding_id", "created_by"})
        result["active"] = self._active(s, row)
        result["solved"] = bool(user_id and s.scalar(select(FlagSolve.id).where(
            FlagSolve.challenge_id == row.id, FlagSolve.user_id == user_id)))
        if admin:
            result["binding_id"] = row.binding_id
        return result
