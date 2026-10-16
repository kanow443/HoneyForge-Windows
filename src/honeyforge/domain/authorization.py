"""Server-side permissions. New operator routes are denied until explicitly classified."""
from honeyforge.domain.errors import DomainError

ROLES = {"admin", "operator", "analyst", "viewer", "participant"}
READ = {"deployment_groups", "deployment_group", "me", "logout", "hosts", "profiles", "profile", "deployments", "deployment", "events", "sessions",
    "session", "playback", "report", "topology", "blocks", "cases", "findings", "overview", "audit", "stream", "artifacts", "storage", "honeytokens", "detection_policy", "geo_top"}
OPERATE = {"deploy_group", "stop_group", "redeploy_group", "create_profile", "version", "update_profile", "archive_profile", "restore_profile", "delete_profile", "deploy", "stop", "redeploy", "create_block", "cancel_block", "create_honeytoken", "revoke_honeytoken", "update_detection_policy"}
INVESTIGATE = {"create_case", "update_case", "export", "download_artifact", "reveal_capture", "pin_case", "export_ioc"}
INVESTIGATE.add("set_event_flag")
ADMIN = {"enrollment", "revoke", "users", "create_user", "change_user_role",
    "integration_tokens", "create_integration_token", "revoke_integration_token", "agent_certificates", "revoke_agent_certificate",
    "create_flag_challenge", "set_flag_challenge", "admin_flag_challenges"}


def authorize(role, route_name):
    if route_name in {"me", "logout", "flag_challenges", "flag_scoreboard"}:
        allowed = ROLES
    elif route_name == "submit_flag":
        allowed = {"participant"}
    else:
        allowed = ROLES - {"participant"} if route_name in READ else {"admin", "operator"} if route_name in OPERATE else (
            {"admin", "operator", "analyst"} if route_name in INVESTIGATE else {"admin"} if route_name in ADMIN else set())
    if role not in allowed:
        raise DomainError("permission_denied", "Your role does not permit this action", 403)
