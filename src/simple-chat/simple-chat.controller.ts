import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { BusinessException } from '../common/business.exception';
import { ErrorCode } from '../common/error-codes';
import { SimpleChatService } from './simple-chat.service';

interface MultipartAudioPart {
  filename: string;
  mimetype?: string;
  file: Readable & { truncated?: boolean };
}

interface MultipartAudioRequest {
  file: (options?: {
    limits?: { files?: number; fileSize?: number };
  }) => Promise<MultipartAudioPart | undefined>;
}

@ApiTags('simple-chat')
@ApiBearerAuth()
@Controller('simple-chat')
export class SimpleChatController {
  constructor(private readonly simpleChatService: SimpleChatService) {}

  @Get('status')
  @ApiOperation({ summary: 'Read the Simple Chat configuration status' })
  status() {
    return this.simpleChatService.getStatus();
  }

  @Get('settings')
  @ApiOperation({ summary: 'Read the Simple Chat execution backend' })
  settings() {
    return this.simpleChatService.getStatus();
  }

  @Put('settings')
  @ApiOperation({ summary: 'Select the Simple Chat execution backend' })
  saveSettings(@Body() body: { backend?: unknown }) {
    return this.simpleChatService.setBackend(body.backend);
  }

  @Put('audio-settings')
  @ApiOperation({
    summary:
      'Choose API or experimental native CLI dictation independently of chat',
  })
  saveAudioSettings(@Body() body: { audioBackend?: unknown }) {
    return this.simpleChatService.setAudioBackend(body.audioBackend);
  }

  @Get('models')
  @ApiOperation({ summary: 'List available OpenAI chat models' })
  models() {
    return this.simpleChatService.listModels();
  }

  @Get('api-key')
  @ApiOperation({ summary: 'Read OpenAI API key status without exposing it' })
  apiKeyStatus() {
    return this.simpleChatService.getKeyStatus();
  }

  @Put('api-key')
  @ApiOperation({ summary: 'Securely replace the managed OpenAI API key' })
  saveApiKey(@Body() body: { apiKey?: unknown }) {
    return this.simpleChatService.saveApiKey(body.apiKey);
  }

  @Post('transcriptions')
  @ApiOperation({ summary: 'Transcribe one voice recording with OpenAI' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  async transcribe(@Req() request: FastifyRequest) {
    const multipart = request as MultipartAudioRequest;
    if (typeof multipart.file !== 'function') {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Audio upload is unavailable',
      );
    }
    let part: MultipartAudioPart | undefined;
    try {
      part = await multipart.file({
        limits: { files: 1, fileSize: this.simpleChatService.maxAudioBytes },
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        throw BusinessException.payloadTooLarge(
          ErrorCode.simpleChat.audioTooLarge,
          'Voice recording is too large',
        );
      }
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioInvalid,
        'Invalid voice recording',
      );
    }
    if (!part) {
      throw BusinessException.badRequest(
        ErrorCode.simpleChat.audioRequired,
        'Voice recording is required',
      );
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of part.file as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    if (part.file.truncated) {
      throw BusinessException.payloadTooLarge(
        ErrorCode.simpleChat.audioTooLarge,
        'Voice recording is too large',
      );
    }
    return this.simpleChatService.transcribeAudio({
      bytes: Buffer.concat(chunks),
      filename: part.filename,
      mimeType: part.mimetype,
    });
  }

  @Get('threads')
  @ApiOperation({ summary: 'List Simple Chat conversations' })
  listThreads() {
    return this.simpleChatService.listThreads();
  }

  @Post('threads')
  @ApiOperation({ summary: 'Create a Simple Chat conversation' })
  createThread(@Body() body: { model?: unknown; projectId?: unknown }) {
    return this.simpleChatService.createThread(body ?? {});
  }

  @Get('threads/:threadId')
  @ApiOperation({ summary: 'Read a Simple Chat conversation and its messages' })
  readThread(@Param('threadId') threadId: string) {
    return this.simpleChatService.readThread(threadId);
  }

  @Patch('threads/:threadId')
  @ApiOperation({ summary: 'Rename a conversation or change its model' })
  updateThread(
    @Param('threadId') threadId: string,
    @Body()
    body: {
      title?: unknown;
      model?: unknown;
      projectId?: unknown;
    },
  ) {
    return this.simpleChatService.updateThread(threadId, body ?? {});
  }

  @Delete('threads/:threadId')
  @ApiOperation({ summary: 'Delete a Simple Chat conversation' })
  deleteThread(@Param('threadId') threadId: string) {
    return this.simpleChatService.deleteThread(threadId);
  }

  @Post('threads/:threadId/messages')
  @ApiOperation({ summary: 'Send a message in a Simple Chat conversation' })
  respond(
    @Param('threadId') threadId: string,
    @Body() body: { message?: unknown },
  ) {
    return this.simpleChatService.respond(threadId, body);
  }
}
