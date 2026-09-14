import { UI_TEXT } from "../uiText";

const T = UI_TEXT.guestDashboard;

export function GuestDashboard() {
  return (
    <div class="dashboard guest-dashboard">
      <header>
        <h1>{T.title}</h1>
        <nav><a href="#/">{T.home}</a></nav>
        <a href="#/login">{T.signIn}</a>
      </header>
      <section class="dashboard-section">
        <h2>{T.gameManagerHeading}</h2>
        <p>{T.intro}</p>
        <div class="modal-actions">
          <a class="button" href="#/new">{T.createRoom}</a>
          <a class="button secondary" href="#/join">{T.joinRoom}</a>
        </div>
        <p class="hint">{T.accountHint}</p>
      </section>
    </div>
  );
}
