# AppShell

The dispatcher dashboard composed from the system: rail, top bar, page header, KPI tiles, flight strips and the attention list.

Grid: `rail-w` rail, then a column with the `topbar-h` top bar and the content area (`canvas`, 20px top and 24px side padding, 20px between regions, 12px between cards). Recreate this layout in `AppLayout.tsx` with Ant Design `Layout`, `Layout.Sider` (dark `Menu`) and `Layout.Header` on `surface`. The preview is the target for the demo's first screen after login; `guidelines/40-screens.md` describes each region.
