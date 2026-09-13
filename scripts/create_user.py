#!/usr/bin/env python3
"""Create a login account for rpg-tabletop. Terminal-only — there is no signup route."""
import argparse
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import init_db  # noqa: E402
from app.auth import create_user  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Create an rpg-tabletop user")
    parser.add_argument("username")
    parser.add_argument("--admin", action="store_true", help="grant admin (room-creation) rights")
    args = parser.parse_args()

    init_db()

    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords do not match.", file=sys.stderr)
        sys.exit(1)
    if len(password) < 4:
        print("Password too short.", file=sys.stderr)
        sys.exit(1)

    try:
        create_user(args.username, password, args.admin)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"User {args.username!r} created{' as admin' if args.admin else ''}.")


if __name__ == "__main__":
    main()
