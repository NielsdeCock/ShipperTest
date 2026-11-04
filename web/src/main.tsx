import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/ui.tsx';
import AddressBook from './pages/AddressBook.tsx';
import NewRun from './pages/NewRun.tsx';
import Origins from './pages/Origins.tsx';
import PairDetail from './pages/PairDetail.tsx';
import Results from './pages/Results.tsx';
import RunProgress from './pages/RunProgress.tsx';
import Runs from './pages/Runs.tsx';
import Settings from './pages/Settings.tsx';
import './styles.css';

function NotFound() {
  return <p>Page not found: <span className="mono">{useLocation().pathname}</span></p>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<NewRun />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunProgress />} />
          <Route path="/runs/:id/results" element={<Results />} />
          <Route path="/results/:id" element={<PairDetail />} />
          <Route path="/addresses" element={<AddressBook />} />
          <Route path="/origins" element={<Origins />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  </StrictMode>,
);
