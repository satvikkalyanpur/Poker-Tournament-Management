'use client';

import { useEffect, useState } from 'react';

export default function AdminConsole() {
  const [tab, setTab] = useState('rbac');
  const [rbac, setRbac] = useState(null);
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    fetch('/api/admin/rbac')
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e))))
      .then(setRbac)
      .catch((e) => setError(e.error ?? 'Not permitted.'));
  }, []);

  useEffect(() => {
    if (tab !== 'audit') return;
    fetch(`/api/admin/audit?page=${page}`).then((r) => r.json()).then(setAudit).catch(() => {});
  }, [tab, page]);

  if (error) return <div className="alert error">{error}</div>;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Admin console</h1>
          <p className="sub">
            Evidence that access control and auditing are enforced by PostgreSQL itself,
            not only by this application.
          </p>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'rbac' ? 'active' : ''}`} onClick={() => setTab('rbac')}>
          Database roles &amp; grants
        </button>
        <button className={`tab ${tab === 'rls' ? 'active' : ''}`} onClick={() => setTab('rls')}>
          Row-level security
        </button>
        <button className={`tab ${tab === 'audit' ? 'active' : ''}`} onClick={() => setTab('audit')}>
          Audit trail
        </button>
      </div>

      {tab === 'rbac' && rbac && (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h3>Database roles</h3>
            <div className="hint">
              Created by db/06_roles_rbac.sql. The application connects as one login role and
              escalates per request with SET LOCAL ROLE, so a leaked connection string still
              cannot read the credentials table.
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Role</th><th>Can log in</th><th>Superuser</th></tr></thead>
                <tbody>
                  {rbac.roles.map((r) => (
                    <tr key={r.rolname}>
                      <td className="mono">{r.rolname}</td>
                      <td>{r.rolcanlogin ? <span className="badge gold">yes</span> : <span className="badge">no</span>}</td>
                      <td>{r.rolsuper ? <span className="badge red">yes</span> : <span className="badge">no</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>Privilege matrix</h3>
            <div className="hint">
              Read live from information_schema.role_table_grants. Note that poker_player has no
              row at all for app_user, hand_player or tournament_transaction.
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Role</th><th>Table</th><th>Privileges</th></tr></thead>
                <tbody>
                  {rbac.grants.map((g, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`badge ${g.grantee === 'poker_admin' ? 'gold'
                          : g.grantee === 'poker_director' ? 'blue' : 'green'}`}>{g.grantee}</span>
                      </td>
                      <td className="mono">{g.table_name}</td>
                      <td className="faint">{g.privileges}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === 'rls' && rbac && (
        <div className="card">
          <h3>Row-level security policies</h3>
          <div className="hint">
            A signed-in player may hold a valid session and still see only their own entries,
            because the policy is applied by the engine after the query is parsed.
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Table</th><th>Policy</th><th>Roles</th><th>Command</th><th>Using expression</th></tr></thead>
              <tbody>
                {rbac.policies.map((p, i) => (
                  <tr key={i}>
                    <td className="mono">{p.tablename}</td>
                    <td className="mono">{p.policyname}</td>
                    <td className="faint">{p.roles}</td>
                    <td><span className="badge">{p.cmd}</span></td>
                    <td className="mono" style={{ fontSize: '.74rem', maxWidth: 330 }}>{p.qual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="card">
          <h3>Audit trail</h3>
          <div className="hint">
            Written by trigger trg_fn_audit. The table has a BEFORE UPDATE OR DELETE trigger that
            raises an exception, so entries cannot be altered or removed once written.
          </div>
          {!audit ? <p className="muted">Loading…</p> : (
            <>
              <div className="faint" style={{ marginBottom: '.6rem' }}>{audit.total} entries</div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th className="num">ID</th><th>Table</th><th>Operation</th><th className="num">Row</th>
                        <th>By</th><th>When</th><th>Change</th></tr>
                  </thead>
                  <tbody>
                    {audit.entries.map((a) => (
                      <tr key={a.audit_id}>
                        <td className="num">{a.audit_id}</td>
                        <td className="mono">{a.table_name}</td>
                        <td>
                          <span className={`badge ${a.operation === 'INSERT' ? 'green'
                            : a.operation === 'DELETE' ? 'red' : 'gold'}`}>{a.operation}</span>
                        </td>
                        <td className="num">{a.row_pk}</td>
                        <td className="faint">{a.changed_by}</td>
                        <td className="faint nowrap">{new Date(a.changed_at).toLocaleString()}</td>
                        <td className="mono" style={{ fontSize: '.7rem', maxWidth: 300, overflow: 'hidden' }}>
                          {a.new_data
                            ? Object.entries(a.new_data).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ')
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: '.5rem', marginTop: '.8rem' }}>
                <button className="ghost small" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
                <button className="ghost small" disabled={audit.page * audit.pageSize >= audit.total}
                        onClick={() => setPage(page + 1)}>Next</button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
