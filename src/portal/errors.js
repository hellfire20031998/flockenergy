export class PortalError extends Error {
  constructor(message, { status, code = 'portal_error', cause } = {}) {
    super(message, { cause });
    this.name = 'PortalError';
    this.status = status;
    this.code = code;
  }
}

export class PortalAuthError extends PortalError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'portal_auth_failed' });
    this.name = 'PortalAuthError';
  }
}

export class PortalNotFoundError extends PortalError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'not_found', status: 404 });
    this.name = 'PortalNotFoundError';
  }
}

export class PortalRateLimitError extends PortalError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'portal_rate_limited', status: 429 });
    this.name = 'PortalRateLimitError';
  }
}
