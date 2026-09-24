import { ArgumentsHost, Catch, HttpException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';

/**
 * `new Types.ObjectId('not-an-id')` throws a BSONError and a Mongoose cast
 * failure throws a CastError — both from inside a handler, both surfacing as
 * an opaque 500 to the caller. They are the caller's fault (a malformed id),
 * so they are answered as 400 here in one place rather than guarded in every
 * controller.
 */
@Catch()
export class MalformedIdFilter extends BaseExceptionFilter {
  constructor(adapterHost: HttpAdapterHost) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof HttpException) && exception instanceof Error) {
      const name = exception.name || exception.constructor?.name;
      const isMalformedId =
        name === 'BSONError' ||
        name === 'CastError' ||
        /must be a 24 character hex string|Cast to ObjectId failed/i.test(exception.message);
      if (isMalformedId) {
        super.catch(
          new HttpException({ statusCode: HttpStatus.BAD_REQUEST, message: 'Malformed id', error: 'Bad Request' }, HttpStatus.BAD_REQUEST),
          host,
        );
        return;
      }
      // Mongo duplicate key (e.g. duplicate client name / phone) is a conflict, not a crash.
      if ((exception as { code?: number }).code === 11000) {
        super.catch(
          new HttpException({ statusCode: HttpStatus.CONFLICT, message: 'Already exists', error: 'Conflict' }, HttpStatus.CONFLICT),
          host,
        );
        return;
      }
    }
    super.catch(exception, host);
  }
}
