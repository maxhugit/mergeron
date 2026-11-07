import { Module } from '@nestjs/common';
import { CodexModule } from '../codex/codex.module';
import { CodexAudioService } from './codex-audio.service';
import { VoiceDictationController } from './voice-dictation.controller';

@Module({
  imports: [CodexModule],
  providers: [CodexAudioService],
  controllers: [VoiceDictationController],
})
export class VoiceDictationModule {}
