// tsx resolves its cache folder from process.geteuid() when available, otherwise
// os.userInfo(). Node 24 can fail the latter call on some restricted Windows hosts.
// Supplying a stable synthetic uid is harmless on Windows and avoids that host-only failure.
if (typeof process.geteuid !== 'function') process.geteuid = () => 0
