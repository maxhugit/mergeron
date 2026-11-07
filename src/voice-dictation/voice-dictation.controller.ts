/** Native Codex dictation only; no API key, chat threads or backend selector. */
import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CodexAudioService } from './codex-audio.service';

@ApiTags('voice-dictation')
@ApiBearerAuth()
@Controller('voice-dictation')
export class VoiceDictationController {
  constructor(private readonly audio: CodexAudioService) {}

  @Post('audio-sessions')
  @ApiOperation({ summary: 'Negotiate native Codex CLI dictation over WebRTC' })
  start(@Body() body: { sdp?: unknown }) {
    return this.audio.start(body?.sdp);
  }

  @Post('audio-sessions/:id/finish')
  @ApiOperation({
    summary: 'Finish owned CLI dictation and return user speech',
  })
  finish(@Param('id') id: string) {
    return this.audio.finish(id);
  }

  @Delete('audio-sessions/:id')
  @ApiOperation({ summary: 'Cancel owned CLI dictation' })
  cancel(@Param('id') id: string) {
    return this.audio.cancel(id);
  }
}
