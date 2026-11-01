/** REST API for runtime-configurable application settings. */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ApiErrorResponseDto } from '../common/dto/api-responses.dto';
import {
  BatchUpdateSettingsDto,
  SettingDto,
  SettingsListResponseDto,
  UpdateSettingDto,
} from './dto/settings.dto';
import { SettingsService, type ResolvedSetting } from './settings.service';
import { ManagerStatusService } from './manager-status.service';
import { ImageUpdateService } from './image-update.service';
import type { IdentityRequest } from '../auth/platform-access.guard';

function updateActor(request?: IdentityRequest) {
  const identity = request?.platformIdentity;
  const id = identity?.impersonation?.administratorId ?? identity?.personId;
  return id
    ? {
        id,
        name:
          identity?.impersonation?.administratorName ?? identity?.name ?? null,
      }
    : undefined;
}

@ApiTags('settings')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: ApiErrorResponseDto })
@ApiBadRequestResponse({ type: ApiErrorResponseDto })
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly managerStatus: ManagerStatusService,
    private readonly imageUpdates: ImageUpdateService,
  ) {}

  /** Reads the image build identity and the latest successfully published release. */
  @Get('release/status')
  @ApiOperation({
    summary: 'Read installed and available Mergeron versions',
  })
  releaseStatus(@Query('refresh') refresh?: string) {
    return this.imageUpdates.status(refresh === 'true');
  }

  @Get('release/installed-changes')
  @ApiOperation({
    summary:
      'Read the last change of the exact installed image, independently of available updates',
  })
  installedChanges() {
    return this.imageUpdates.installedChanges();
  }

  @Get('manager/image-updates')
  @ApiOperation({
    summary:
      'Discover registry updates for managed containers without pulling images',
  })
  managerImageUpdates(@Query('refresh') refresh?: string) {
    return this.managerStatus.imageUpdates(refresh === 'true');
  }

  /** Proxies the observe-only local stack inventory exposed by Mergeron Manager. */
  @Get('manager/status')
  @ApiOperation({ summary: 'Read Mergeron stack health and data safeguards' })
  managerStackStatus() {
    return this.managerStatus.status();
  }

  /** Records the exact current installation without recreating containers or moving data. */
  @Post('manager/adopt')
  @ApiOperation({ summary: 'Adopt the verified existing Mergeron stack' })
  adoptManagerStack(
    @Body()
    body: {
      confirmation?: unknown;
      expectedFingerprint?: unknown;
    },
  ) {
    return this.managerStatus.adopt(body);
  }

  /** Returns an immutable, non-destructive installation preview. */
  @Get('manager/install/plan')
  @ApiOperation({ summary: 'Preview the first Mergeron installation' })
  managerInstallationPlan() {
    return this.managerStatus.installationPlan();
  }

  /** Applies exactly the previously reviewed installation plan. */
  @Post('manager/install')
  @ApiOperation({ summary: 'Install missing Mergeron resources' })
  installManagerStack(
    @Body()
    body: {
      confirmation?: unknown;
      expectedFingerprint?: unknown;
    },
  ) {
    return this.managerStatus.install(body);
  }

  /** Lists runtime settings with optional category filtering. */
  @Post('manager/update/plan')
  @ApiOperation({ summary: 'Preview a transactional stack update' })
  managerUpdatePlan(
    @Body() body: { images?: unknown; mode?: unknown; backupMode?: unknown },
  ) {
    return this.managerStatus.updateOperation('plan', body);
  }

  @Get('manager/backups')
  @ApiOperation({
    summary: 'List saved update backups without private transaction data',
  })
  managerBackups() {
    return this.managerStatus.backups();
  }

  @Get('manager/update/history')
  managerHistory() {
    return this.managerStatus.updateHistory();
  }

  @Get('manager/update/history/:id/changes')
  async managerHistoryChanges(@Param('id') id: string) {
    const history = await this.managerStatus.updateHistory();
    const operations = Array.isArray(history.operations)
      ? (history.operations as Record<string, unknown>[])
      : [];
    const operation = operations.find((op) => op.id === id);
    return operation
      ? this.imageUpdates.operationChanges(operation)
      : { items: [], unavailable: true };
  }

  @Post('manager/update/restore-plan')
  managerRestorePlan(@Body() body: { operationId?: unknown }) {
    return this.managerStatus.updateOperation('restore-plan', {
      operationId: body.operationId,
    });
  }

  @Post('manager/update/checkpoint-plan')
  managerCheckpointPlan() {
    return this.managerStatus.updateOperation('checkpoint-plan', {});
  }

  @Post('manager/update/checkpoint')
  managerCheckpoint(
    @Body() body: { confirmation?: unknown; expectedFingerprint?: unknown },
    @Req() request: IdentityRequest,
  ) {
    return this.managerStatus.updateOperation('checkpoint', {
      confirmation: body.confirmation,
      expectedFingerprint: body.expectedFingerprint,
      actor: updateActor(request),
    });
  }

  @Post('manager/update/restore')
  managerRestore(
    @Body()
    body: {
      operationId?: unknown;
      confirmation?: unknown;
      expectedFingerprint?: unknown;
    },
    @Req() request: IdentityRequest,
  ) {
    return this.managerStatus.updateOperation('restore', {
      operationId: body.operationId,
      confirmation: body.confirmation,
      expectedFingerprint: body.expectedFingerprint,
      actor: updateActor(request),
    });
  }

  @Post('manager/backups/delete')
  @ApiOperation({ summary: 'Delete one explicitly confirmed update backup' })
  managerDeleteBackup(
    @Body() body: { operationId?: unknown; confirmation?: unknown },
  ) {
    return this.managerStatus.deleteBackup(body);
  }

  @Get('manager/backups/retention')
  managerBackupRetention() {
    return this.managerStatus.backupRetention();
  }

  @Post('manager/backups/retention')
  managerSetBackupRetention(@Body() body: { maxBackups?: unknown }) {
    return this.managerStatus.setBackupRetention(body);
  }

  @Post('manager/update')
  @ApiOperation({ summary: 'Start a confirmed transactional stack update' })
  managerUpdate(
    @Body()
    body: {
      images?: unknown;
      mode?: unknown;
      backupMode?: unknown;
      confirmation?: unknown;
      expectedFingerprint?: unknown;
    },
    @Req() request?: IdentityRequest,
  ) {
    return this.managerStatus.updateOperation('apply', {
      ...body,
      actor: updateActor(request),
    });
  }

  @Post('manager/update/rollback')
  @ApiOperation({ summary: 'Restore the previous stack and its saved data' })
  managerRollback(
    @Body() body: { confirmation?: unknown; operationId?: unknown },
  ) {
    return this.managerStatus.updateOperation('rollback', body);
  }

  @Post('manager/update/recover')
  @ApiOperation({ summary: 'Retry an interrupted update recovery' })
  managerRecover(@Body() body: { confirmation?: unknown }) {
    return this.managerStatus.updateOperation('recover', body);
  }

  /** Lists runtime settings with optional category filtering. */
  @Get()
  @ApiOperation({ summary: 'List runtime settings' })
  @ApiQuery({ name: 'category', required: false })
  @ApiOkResponse({ type: SettingsListResponseDto })
  listSettings(@Query('category') category?: string): SettingsListResponseDto {
    return { settings: this.settingsService.listSettings(category) };
  }

  /** Reads a single runtime setting by key. */
  @Get(':key')
  @ApiOperation({ summary: 'Read one runtime setting' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  getSetting(@Param('key') key: string): ResolvedSetting {
    return this.settingsService.getSetting(key);
  }

  /** Atomically updates multiple settings after validating every value. */
  @Patch()
  @ApiOperation({ summary: 'Batch update runtime settings' })
  @ApiOkResponse({ type: SettingsListResponseDto })
  updateSettings(
    @Body() body: BatchUpdateSettingsDto,
  ): SettingsListResponseDto {
    if (!Array.isArray(body?.updates)) {
      throw BusinessException.badRequest(
        ErrorCode.settings.updatesRequired,
        'updates must be an array',
      );
    }
    return { settings: this.settingsService.updateSettings(body.updates) };
  }

  /** Updates one setting; value=null clears the DB override. */
  @Patch(':key')
  @ApiOperation({ summary: 'Update one runtime setting' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  updateSetting(
    @Param('key') key: string,
    @Body() body: UpdateSettingDto,
  ): ResolvedSetting {
    if (!Object.prototype.hasOwnProperty.call(body ?? {}, 'value')) {
      throw BusinessException.badRequest(
        ErrorCode.validation.fieldRequired,
        'value is required',
        { field: 'value' },
      );
    }
    return this.settingsService.updateSetting(key, body.value);
  }

  /** Clears the DB override so the setting falls back to env/default. */
  @Delete(':key')
  @ApiOperation({ summary: 'Reset one runtime setting to env/default' })
  @ApiParam({ name: 'key' })
  @ApiOkResponse({ type: SettingDto })
  resetSetting(@Param('key') key: string): ResolvedSetting {
    return this.settingsService.resetSetting(key);
  }
}
