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
}
