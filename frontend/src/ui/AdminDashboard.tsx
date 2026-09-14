import { useEffect, useState } from "preact/hooks";
import { ApiError, Me, RoomSummary, UserSummary, auth, rooms, users } from "../net/api";
import { StoredPackage, PackageStore } from "../packages/packageStore";
import { rememberRoomPackageId } from "../roomPackageChoice";
import { UI_TEXT } from "../uiText";

const T = UI_TEXT.adminDashboard;
const packageStore = new PackageStore();

export function AdminDashboard({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const [roomList, setRoomList] = useState<RoomSummary[]>([]);
  const [userList, setUserList] = useState<UserSummary[]>([]);
  const [customPackages, setCustomPackages] = useState<StoredPackage[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [roomName, setRoomName] = useState("");
  const [roomPassword, setRoomPassword] = useState("");
  const [roomPackage, setRoomPackage] = useState("bundled:generic-freeform");
  const [createRoomOpen, setCreateRoomOpen] = useState(false);

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
      setCreateRoomOpen(false);
      await refresh();
      location.hash = `#/room/${slug}`;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function deleteRoom(slug: string, name: string) {
    if (!confirm(T.deleteRoomConfirm(name))) return;
    setError(null);
    try {
      await rooms.delete(slug);
      await refresh();
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
        <h1>{T.title}</h1>
        <nav>
          <a href="#/packages">{T.gamePackagesNavLink}</a>
        </nav>
        <div>
          {T.loggedInAsPrefix}
          <strong>{me.username}</strong>
          <button onClick={logout}>{T.logOut}</button>
        </div>
      </header>

      {error && <p class="error">{error}</p>}

      <section class="dashboard-section">
        <h2>{T.yourRoomsHeading}</h2>
        <ul class="room-list">
          {roomList.map((r) => (
            <li key={r.slug}>
              <a href={`#/room/${r.slug}`}>{r.name}</a>
              <span class="hint">
                {" "}
                &middot; {r.gameDefRef} {r.hasPassword ? "\u{1F512}" : ""} &middot;{" "}
                <a href={`#/join/${r.slug}`}>{T.guestLinkLabel}</a>
              </span>{" "}
              <button class="room-delete-button" onClick={() => deleteRoom(r.slug, r.name)}>
                {T.delete}
              </button>
            </li>
          ))}
          {roomList.length === 0 && <li class="hint">{T.noRoomsHint}</li>}
        </ul>
        <button onClick={() => setCreateRoomOpen(true)}>{T.createRoom}</button>
      </section>

      {createRoomOpen && (
        <div class="modal-overlay" onClick={() => setCreateRoomOpen(false)}>
          <form class="modal" onSubmit={createRoom} onClick={(e) => e.stopPropagation()}>
            <h2>{T.createRoomTitle}</h2>
            <label>
              {T.roomNamePlaceholder}
              <input value={roomName} onInput={(e) => setRoomName((e.target as HTMLInputElement).value)} required autofocus />
            </label>
            <label>
              {T.passwordOptionalPlaceholder}
              <input value={roomPassword} onInput={(e) => setRoomPassword((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              {T.gamePackagesNavLink}
              <select value={roomPackage} onChange={(e) => setRoomPackage((e.target as HTMLSelectElement).value)}>
                <option value="bundled:generic-freeform">{T.genericFreeformOption}</option>
                <option value="bundled:dnd5e-srd">{T.dnd5eOption}</option>
                {customPackages.map((p) => (
                  <option value={`custom:${p.id}`} key={p.id}>
                    {T.yourPackageOption(p.pkg.name)}
                  </option>
                ))}
              </select>
            </label>
            <div class="modal-actions">
              <button type="button" onClick={() => setCreateRoomOpen(false)}>{T.cancel}</button>
              <button type="submit">{T.createRoom}</button>
            </div>
          </form>
        </div>
      )}

      <section class="dashboard-section">
        <h2>{T.usersHeading}</h2>
        <ul class="room-list">
          {userList.map((u) => (
            <li key={u.username}>
              {u.username} {u.isAdmin ? T.adminSuffix : ""}
            </li>
          ))}
        </ul>
        <form onSubmit={createUser}>
          <input
            placeholder={T.usernamePlaceholder}
            value={newUsername}
            onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
            required
          />
          <input
            placeholder={T.tempPasswordPlaceholder}
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
            {T.adminCheckboxLabel}
          </label>
          <button type="submit">{T.createUser}</button>
        </form>
      </section>
    </div>
  );
}
