import { NavLink, Route, Routes } from 'react-router-dom';
import { isLocal, resetLocal, skip, usesServer } from './api.js';
import { short } from './format.js';
import Choir from './pages/Choir.jsx';
import Desk from './pages/Desk.jsx';
import Home from './pages/Home.jsx';
import Market from './pages/Market.jsx';
import Start from './pages/Start.jsx';
import { useSession } from './session.jsx';
import { Mark } from './ui.jsx';

const DAY = 86_400_000;

function Who() {
  const { config, user, setUser, connect, disconnect } = useSession();
  if (usesServer()) {
    return (
      <label className="who">
        <span className="muted">You are</span>
        <select value={user ?? ''} onChange={(event) => setUser(event.target.value)} aria-label="Act as">
          {config.personas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.role ? ` · ${p.role}` : ''}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (!user) {
    return (
      <button className="btn small" onClick={connect}>
        Connect wallet
      </button>
    );
  }
  return (
    <div className="who">
      <span className="chip mono">{user.length > 26 ? `${short(user)}…` : user}</span>
      <button className="btn ghost small" onClick={disconnect}>
        Sign out
      </button>
    </div>
  );
}

function PracticeBar() {
  const { act, toast, refresh } = useSession();
  if (!isLocal()) return null;
  const jump = (days, label) =>
    act(async () => {
      await skip(days * DAY);
      return null;
    }, `${label} later.`);
  return (
    <div className="practice">
      <div className="wrap">
        <span>
          <b>Practice chain.</b> The real contracts, running on this computer. No wallet, no real money.
        </span>
        <span className="spacer" />
        <button onClick={() => jump(1, 'One day')}>Skip a day</button>
        <button onClick={() => jump(7, 'One week')}>Skip a week</button>
        <button
          onClick={async () => {
            await resetLocal();
            toast('Everything is back to the start.');
            refresh();
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const { config } = useSession();
  const link = ({ isActive }) => (isActive ? 'on' : '');
  return (
    <>
      <header className="bar">
        <div className="wrap">
          <NavLink to="/" className="brand">
            <Mark />
            Choir
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end className={link}>
              Choirs
            </NavLink>
            <NavLink to="/market" className={link}>
              Seats for sale
            </NavLink>
            <NavLink to="/start" className={link}>
              Start a Choir
            </NavLink>
          </nav>
          <Who />
        </div>
      </header>
      <PracticeBar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/market" element={<Market />} />
        <Route path="/start" element={<Start />} />
        <Route path="/c/:id" element={<Choir />} />
        <Route path="/c/:id/desk" element={<Desk />} />
        <Route path="*" element={<Home />} />
      </Routes>
      <footer className="foot">
        <div className="wrap">
          Choir runs on NEAR {config.network === 'local' ? '(practice chain)' : config.network}. Collection{' '}
          <span className="mono">{config.collection}</span>. Every Choir is its own account with no access keys. What it shows on
          near.social is written by its contract, never by a person.
        </div>
      </footer>
    </>
  );
}
