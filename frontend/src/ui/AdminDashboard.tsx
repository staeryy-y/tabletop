import { useEffect, useState } from "preact/hooks";
import { ApiError, Me, RoomSummary, UserSummary, auth, rooms, users } from "../net/api";
import { StoredPackage, PackageStore } from "../packages/packageStore";
import { rememberRoomPackageId } from "../roomPackageChoice";

const packageStore = new PackageStore();

export function AdminDashboard({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const [roomList, setRoomList] = useState<RoomSummary[]>([]);
  const [userList, setUserList] = useState<UserSummary[]>([]);
  const [customPackages, setCustomPackages] = useState<StoredPackage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [roomName, setRoomName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [roomPackage, setRoomPackage] = useState("bundled:generic-freeform");

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newIsAdmin, setNewIsAdmin] = useState(false);

  async function refresh() {
    try {
      setRoomList(await rooms.list());
      setUserList(await users.list());
      setCustomPackages(await packageStore.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createRoom(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      const isCustom = roomPackage.startsWith("custom:");
      const { slug } = await rooms.create(roomName, roomPassword || null, isCustom ? "custom" : roomPackage);
      if (isCustom) rememberRoomPackageId(slug, roomPackage.slice("custom:".length));
      setRoomName("");
      setRoomPassword("");
      await refresh();
      location.hash = `#/room/${slug}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function createUser(e: Event) {
    e.preventDefault();
    setError(null);
    try {
      await users.create(newUsername, newPassword, newIsAdmin);
      setNewUsername("");
      setNewPassword("");
      setNewIsAdmin(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function logout() {
    await auth.logout();
    onLoggedOut();
  }

  return (
    <div class="dashboard">
      <header>
        <h1>rpg-tabletop</h1>
        <nav>
          <a href="#/packages">Game packages</a>
        </nav>
        <div>
          Logged in as <strong>{me.username}</strong>
          <button onClick={logout}>Log out</button>
        </div>
      </header>

      {error && <p class="error">{error}</p>}

      <section class="panel">
        <h2>Your rooms</h2>
        <ul class="room-list">
          {roomList.map((r) => (
            <li key={r.slug}>
              <a href={`#/room/${r.slug}`}>{r.name}</a>
              <span class="hint">
                {" "}
                &middot; {r.gameDefRef} {r.hasPassword ? "\u{1F512}" : ""} &middot;{" "}
                <a href={`#/join/${r.slug}`}>guest link</a>
              </span>
            </li>
          ))}
          {roomList.length === 0 && <li class="hint">No rooms yet — create one below.</li>}
        </ul>
        <form onSubmit={createRoom}>
          <input
            placeholder="Room name"
            value={roomName}
            onInput={(e) => setRoomName((e.target as HTMLInputElement).value)}
            required
          />
          <input
            placeholder="Password (optional)"
            value={roomPassword}
            onInput={(e) => setRoomPassword((e.target as HTMLInputElement).value)}
          />
          <select value={roomPackage} onChange={(e) => setRoomPackage((e.target as HTMLSelectElement).value)}>
            <option value="bundled:generic-freeform">Generic Freeform</option>
            <option value="bundled:dnd5e-srd">D&amp;D 5e (SRD)</option>
            {customPackages.map((p) => (
              <option value={`custom:${p.id}`} key={p.id}>
                {p.pkg.name} (yours)
              </option>
            ))}
          </select>
          <button type="submit">Create room</button>
        </form>
      </section>

      <section class="panel">
        <h2>Users</h2>
        <ul class="room-list">
          {userList.map((u) => (
            <li key={u.username}>
              {u.username} {u.isAdmin ? "(admin)" : ""}
            </li>
          ))}
        </ul>
        <form onSubmit={createUser}>
          <input
            placeholder="Username"
            value={newUsername}
            onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
            required
          />
          <input
            placeholder="Temp password"
            value={newPassword}
            onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
            required
          />
          <label class="checkbox">
            <input
              type="checkbox"
              checked={newIsAdmin}
              onChange={(e) => setNewIsAdmin((e.target as HTMLInputElement).checked)}
            />
            admin
          </label>
          <button type="submit">Create user</button>
        </form>
      </section>
    </div>
  );
}
