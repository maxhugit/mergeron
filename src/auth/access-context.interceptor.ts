import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { accessContext } from './access-context';
import { IdentityService } from './identity.service';
import type { IdentityRequest } from './platform-access.guard';

@Injectable()
export class AccessContextInterceptor implements NestInterceptor {
  constructor(private readonly identities: IdentityService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const identity = context
      .switchToHttp()
      .getRequest<IdentityRequest>().platformIdentity;
    if (!identity) return next.handle();
    return new Observable((subscriber) =>
      accessContext.run({ identity, identities: this.identities }, () =>
        next
          .handle()
          .pipe(
            tap({
              complete: () => {
                if (
                  identity.impersonation &&
                  !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
                )
                  this.identities.auditImpersonation(
                    identity.impersonation,
                    'httpCompleted',
                    request.method,
                    request.url,
                  );
              },
              error: () => {
                if (
                  identity.impersonation &&
                  !['GET', 'HEAD', 'OPTIONS'].includes(request.method)
                )
                  this.identities.auditImpersonation(
                    identity.impersonation,
                    'httpFailed',
                    request.method,
                    request.url,
                  );
              },
            }),
          )
          .subscribe(subscriber),
      ),
    );
  }
}
