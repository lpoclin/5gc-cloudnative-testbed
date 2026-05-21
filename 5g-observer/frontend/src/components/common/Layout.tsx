import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'

const NAV_LINKS = [
  { to: '/',             label: 'Topology',       shortcut: '1' },
  { to: '/infrastructure', label: 'Infrastructure', shortcut: '2' },
  { to: '/captures',    label: 'Captures',       shortcut: '3' },
]

export default function Layout() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-bg-primary">
      {/* Top navigation */}
      <header className="flex items-center gap-6 px-4 h-11 border-b border-border bg-bg-secondary shrink-0 z-20">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-2">
          <svg className="w-6 h-6" viewBox="0 0 32 32" fill="none">
            <circle cx="16" cy="16" r="6" fill="none" stroke="#3b82f6" strokeWidth="2"/>
            <circle cx="16" cy="8"  r="2.5" fill="#22c55e"/>
            <circle cx="22" cy="12" r="2.5" fill="#f97316"/>
            <circle cx="22" cy="20" r="2.5" fill="#a855f7"/>
            <circle cx="16" cy="24" r="2.5" fill="#22c55e"/>
            <circle cx="10" cy="20" r="2.5" fill="#3b82f6"/>
            <circle cx="10" cy="12" r="2.5" fill="#3b82f6"/>
            <line x1="16" y1="10.5" x2="16" y2="14" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="20" y1="13"   x2="18" y2="14.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="20" y1="19"   x2="18" y2="17.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="16" y1="21.5" x2="16" y2="18"   stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="12" y1="19"   x2="14" y2="17.5" stroke="#3b82f6" strokeWidth="1.5"/>
            <line x1="12" y1="13"   x2="14" y2="14.5" stroke="#3b82f6" strokeWidth="1.5"/>
          </svg>
          <span className="font-mono text-sm font-bold text-slate-100 tracking-tight select-none">
            5G-OBSERVER
          </span>
        </div>

        {/* Nav links */}
        <nav className="flex items-center gap-1">
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                clsx(
                  'px-3 py-1 rounded text-sm font-medium transition-colors duration-100',
                  isActive
                    ? 'bg-blue-600/20 text-blue-400 border border-blue-600/40'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-bg-hover',
                )
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right: version badge */}
        <span className="text-xs text-slate-600 font-mono select-none">v0.1.0</span>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
