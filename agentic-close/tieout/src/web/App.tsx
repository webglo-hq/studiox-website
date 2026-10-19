/** Route switch (hash routing) with sign-in / MFA gating and a render-error boundary. */
import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { Empty, Loading } from './components/ui';
import { can, useApp } from './lib/app-state';
import { useRoute } from './lib/router';
import { Admin } from './pages/Admin';
import { Audit } from './pages/Audit';
import { Close } from './pages/Close';
import { Documents } from './pages/Documents';
import { Flux } from './pages/Flux';
import { Home } from './pages/Home';
import { Imports } from './pages/Imports';
import { Inbox } from './pages/Inbox';
import { Journal } from './pages/Journal';
import { Login } from './pages/Login';
import { Ontology } from './pages/Ontology';
import { Package } from './pages/Package';
import { Recs } from './pages/Recs';
import { Reports } from './pages/Reports';
import { Runs } from './pages/Runs';
import { Skills } from './pages/Skills';

const ROUTES: Record<string, { title: string; perm?: string; render: () => ReactNode }> = {
  home: { title: 'My close', render: () => <Home /> },
  close: { title: 'Close cockpit', perm: 'close.view', render: () => <Close /> },
  inbox: { title: 'Inbox', perm: 'proposal.view', render: () => <Inbox /> },
  recs: { title: 'Reconciliations', perm: 'subledger.read', render: () => <Recs /> },
  flux: { title: 'Flux analysis', perm: 'report.view', render: () => <Flux /> },
  journal: { title: 'Journal entries', perm: 'ledger.read', render: () => <Journal /> },
  reports: { title: 'Statements', perm: 'report.view', render: () => <Reports /> },
  runs: { title: 'Agent runs', perm: 'agent.view', render: () => <Runs /> },
  skills: { title: 'Skills', perm: 'skill.view', render: () => <Skills /> },
  ontology: { title: 'Ontology', perm: 'ontology.view', render: () => <Ontology /> },
  audit: { title: 'Audit log', perm: 'audit.view', render: () => <Audit /> },
  admin: { title: 'Admin', render: () => <Admin /> },
  imports: { title: 'Imports', perm: 'import.view', render: () => <Imports /> },
  documents: { title: 'Source document', perm: 'subledger.read', render: () => <Documents /> },
  package: { title: 'Close package', perm: 'report.view', render: () => <Package /> },
};

export function App() {
  const { me, loading, mfaPending } = useApp();
  const route = useRoute();
  const page = route.path[0] ?? 'home';
  const def = ROUTES[page];
  useEffect(() => {
    document.title = me && def ? `${def.title} · Tieout` : 'Tieout · Sign in';
  }, [me, def]);
  if (loading)
    return (
      <div className="boot">
        <Loading label="Opening Tieout" />
      </div>
    );
  if (!me || mfaPending) return <Login />;
  let body: ReactNode;
  if (!def) body = <Empty title="Page not found">That address does not match a screen. Use the navigation to continue.</Empty>;
  else if (def.perm && !can(me, def.perm)) body = <Empty title="Not available for your role">Ask an administrator if you need access to {def.title.toLowerCase()}.</Empty>;
  else body = def.render();
  return (
    <Layout>
      <Boundary key={page}>{body}</Boundary>
    </Layout>
  );
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen failed to render', error, info.componentStack);
  }
  override render() {
    if (this.state.error)
      return (
        <div className="callout bad" role="alert">
          <div>
            <strong>This screen hit an error.</strong> {this.state.error.message}{' '}
            <button className="btn small" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}
