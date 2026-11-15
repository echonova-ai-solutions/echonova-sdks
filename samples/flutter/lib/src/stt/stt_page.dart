/// The Speech to Text screen.
library;

import 'package:echonova_ai/echonova_ai.dart';
import 'package:flutter/material.dart';

import '../format.dart';
import 'stt_controller.dart';

/// Talk; transcripts appear as you pause; stop for the session's summary.
class SttPage extends StatelessWidget {
  /// Shows [controller].
  const SttPage({super.key, required this.controller});

  /// The screen's state.
  final SttController controller;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) {
        final theme = Theme.of(context);
        final status = controller.status;
        final direction = controller.language == 'ar'
            ? TextDirection.rtl
            : TextDirection.ltr;
        return ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'ar', label: Text('Arabic')),
                ButtonSegment(value: 'en', label: Text('English')),
              ],
              selected: {controller.language},
              onSelectionChanged: status == SttStatus.idle
                  ? (selected) => controller.selectLanguage(selected.single)
                  : null,
            ),
            const SizedBox(height: 16),
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: _RecordButton(controller: controller),
            ),
            const SizedBox(height: 8),
            Text(switch (status) {
              SttStatus.idle =>
                'Tap Start and speak. Pause to see what you '
                    'said; tap Stop to finish.',
              SttStatus.starting => 'Opening the microphone and the session…',
              SttStatus.listening =>
                'Listening. Transcripts appear when '
                    'you pause.',
              SttStatus.stopping => 'Transcribing the rest…',
            }, style: theme.textTheme.bodyMedium),
            if (status == SttStatus.starting || status == SttStatus.stopping)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: LinearProgressIndicator(),
              ),
            const SizedBox(height: 8),
            for (final transcript in controller.transcripts)
              Card(
                child: ListTile(
                  title: Text(transcript.text.trim(), textDirection: direction),
                  subtitle: Text(
                    '${formatNumber(transcript.durationSeconds)} s',
                  ),
                ),
              ),
            if (controller.summary case final summary?)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(_describe(summary), key: const Key('summary')),
              ),
            if (controller.warning case final warning?)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(warning, style: theme.textTheme.bodySmall),
              ),
            if (controller.error case final error?)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  error,
                  key: const Key('error'),
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ),
          ],
        );
      },
    );
  }
}

class _RecordButton extends StatelessWidget {
  const _RecordButton({required this.controller});

  final SttController controller;

  @override
  Widget build(BuildContext context) {
    const key = Key('record');
    return switch (controller.status) {
      SttStatus.idle => FilledButton.icon(
        key: key,
        onPressed: controller.start,
        icon: const Icon(Icons.mic),
        label: const Text('Start'),
      ),
      SttStatus.starting || SttStatus.listening => FilledButton.icon(
        key: key,
        onPressed: controller.stop,
        icon: const Icon(Icons.stop),
        label: const Text('Stop'),
      ),
      SttStatus.stopping => FilledButton.icon(
        key: key,
        onPressed: null,
        icon: const Icon(Icons.hourglass_top),
        label: const Text('Finishing'),
      ),
    };
  }
}

String _describe(SessionSummary summary) => [
  'Session ended (${summary.reason})',
  '${formatNumber(summary.totalSeconds)} s transcribed',
  '${formatNumber(summary.creditsConsumed)} credits',
  switch (summary.savedStatus) {
    SessionSaveStatus.saved => 'saved as job ${summary.jobId}',
    SessionSaveStatus.empty => 'nothing to save',
    SessionSaveStatus.failed => 'could not be saved',
    SessionSaveStatus.unknown || null => null,
  },
].nonNulls.join(' · ');
