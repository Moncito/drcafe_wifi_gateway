/** A café code as the router reports it. */
export interface RouterUser {
  id: string;
  name: string;
  comment: string;
  disabled: boolean;
  profile: string;
}

/** A logged-in device as the router reports it. id = "CODE|MAC". */
export interface RouterActive {
  id: string;
  user: string;
  address: string;
  mac: string;
  uptime: string;
  sessionTimeLeft: string;
  hostName: string;
}

export interface RouterInfo {
  identity: string;
  board: string;
  version: string;
  /** Comment of the drc-backup scheduler: "drc last backup <date> <time> <file>" */
  backupComment: string;
  groupDevices: string;
  rateLimit: string;
  idleTimeout: string;
  /** Router uptime as RouterOS prints it ("1d02:03:04", "28m36s"); "" from older scripts */
  uptime: string;
  /** NTP client status ("synchronized" when the router clock is right); "" from older scripts */
  clock: string;
}
