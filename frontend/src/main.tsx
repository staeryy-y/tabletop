import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./style.css";
import { ApiError, Me, auth } from "./net/api";
import { Login } from "./ui/Login";
import { AccountSetup } from "./ui/AccountSetup";
import { AdminDashboard } from "./ui/AdminDashboard";
import { RoomJoin } from "./ui/RoomJoin";
import { RoomTable } from "./ui/RoomTable";

type Route = { view: "dashboard" } | { view: "join"; slug: string } | { view: "room"; slug: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [kind, slug] = hash.split("/");
  if (kind === "join" && slug) return { view: "join", slug };
  if (kind === "room" && slug) return { view: "room", slug };
  return { view: "dashboard" };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading
  const route = useHashRoute();

  useEffect(() => {
    auth
      .me()
      .then(setMe)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setMe(null);
        else setMe(null);
      });
  }, []);

  // Guest routes (join/room) never require an admin session — a room is joinable by
  // display name alone. Only the dashboard needs one.
  if (route.view === "join") return <RoomJoin slug={route.slug} />;
  if (route.view === "room") return <RoomTable slug={route.slug} />;

  if (me === undefined) return <div class="centered-page">Loading…</div>;
  if (me === null) return <Login onLoggedIn={setMe} />;
  if (me.mustChangePassword) return <AccountSetup me={me} onDone={setMe} />;
  return <AdminDashboard me={me} onLoggedOut={() => setMe(null)} />;
}

render(<App />, document.getElementById("app")!);
