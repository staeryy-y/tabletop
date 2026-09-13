// Thin wrapper around the backend's JSON API (see app/routes_auth.py, routes_users.py,
// rooms.py). Session auth rides on the same-origin cookie automatically; guest room
// tokens are returned by joinRoom() and passed explicitly by the caller into the
// signaling WebSocket URL.

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      detail = data.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Me {
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export const auth = {
  login: (username: string, password: string) =>
    request<Me>("POST", "/api/auth/login", { username, password }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => request<Me>("GET", "/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("POST", "/api/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  /** The forced first-login flow — see app/routes_auth.py's complete_setup: a fresh
   * account's username is as much a placeholder as its password, so both change
   * together here rather than just the password. */
  completeSetup: (currentPassword: string, newUsername: string, newPassword: string) =>
    request<Me>("POST", "/api/auth/complete-setup", {
      current_password: currentPassword,
      new_username: newUsername,
      new_password: newPassword,
    }),
};

export interface UserSummary {
  username: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export const users = {
  list: () => request<UserSummary[]>("GET", "/api/users"),
  create: (username: string, password: string, isAdmin: boolean) =>
    request<{ ok: true }>("POST", "/api/users", { username, password, is_admin: isAdmin }),
};

export interface RoomSummary {
  slug: string;
  name: string;
  gameDefRef: string;
  hasPassword: boolean;
  createdAt: string;
}

export interface RoomPublicInfo {
  slug: string;
  name: string;
  gameDefRef: string;
  hasPassword: boolean;
}

export interface JoinResult {
  token: string;
  guestId: string;
  displayName: string;
}

export const rooms = {
  list: () => request<RoomSummary[]>("GET", "/api/rooms"),
  create: (name: string, password: string | null, gameDefRef?: string) =>
    request<{ slug: string }>("POST", "/api/rooms", {
      name,
      password: password || null,
      ...(gameDefRef ? { game_def_ref: gameDefRef } : {}),
    }),
  /** No account needed at all (docs/DECISIONS.md D19) — anyone can host a game. The
   * server never persists this room anywhere; see app/rooms.py's own docstring. */
  createAnonymous: (name: string, password: string | null, gameDefRef?: string) =>
    request<{ slug: string }>("POST", "/api/rooms/anonymous", {
      name,
      password: password || null,
      ...(gameDefRef ? { game_def_ref: gameDefRef } : {}),
    }),
  get: (slug: string) => request<RoomPublicInfo>("GET", `/api/rooms/${slug}`),
  join: (slug: string, displayName: string, password?: string) =>
    request<JoinResult>("POST", `/api/rooms/${slug}/join`, {
      display_name: displayName,
      password: password || null,
    }),
  /** Accounted rooms only — an anonymous room has no dashboard listing to delete it
   * from and already discards itself the moment it's empty. */
  delete: (slug: string) => request<void>("DELETE", `/api/rooms/${slug}`),
};
