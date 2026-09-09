export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthorizedError extends AppError {
  public constructor(message = 'A valid bearer token is required') {
    super(401, 'unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  public constructor(message = 'You do not have access to this resource') {
    super(403, 'forbidden', message);
  }
}

export class NotFoundError extends AppError {
  public constructor(resource: string) {
    super(404, 'not_found', `${resource} was not found`);
  }
}

export class ConflictError extends AppError {
  public constructor(code: string, message: string) {
    super(409, code, message);
  }
}
