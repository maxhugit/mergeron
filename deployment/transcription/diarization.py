"""Local acoustic diarization and conservative word/turn reconciliation.

No dialogue, names or transcript semantics are used to assign a voice.
Thresholds are timing heuristics, not calibrated speaker probabilities.
"""
import math

MIN_TURN_SECONDS = 0.5
MIN_COVERAGE = 0.8
MIN_CONFLICT_SECONDS = 0.05


def union_duration(intervals):
    total = 0.0
    end = -math.inf
    for a, b in sorted(intervals):
        if b > max(a, end):
            total += b - max(a, end)
        end = max(end, b)
    return total


def normalize_turns(turns, duration):
    cleaned = []
    for start, end, speaker in turns:
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            raise ValueError("DIARIZATION_INVALID_TURNS")
        start, end = max(0.0, start), min(duration, end)
        if end > start:
            cleaned.append((start, end, str(speaker)))
    # Reunite touching fragments of the same acoustic turn before checking length.
    by_speaker = {}
    for start, end, speaker in sorted(cleaned):
        runs = by_speaker.setdefault(speaker, [])
        if runs and start <= runs[-1][1] + 0.001:
            runs[-1] = (runs[-1][0], max(end, runs[-1][1]))
        else:
            runs.append((start, end))
    return sorted((a, b, s) for s, runs in by_speaker.items() for a, b in runs)


def speaker_for(start, end, turns):
    """Keep ambiguous, overlapping and very short acoustic turns unattributed."""
    length = end - start
    if length <= 0:
        return None
    by_speaker = {}
    for a, b, speaker in turns:
        left, right = max(a, start), min(b, end)
        if right > left:
            by_speaker.setdefault(speaker, []).append((left, right, b - a))
    coverage = sorted(((union_duration([(a, b) for a, b, _ in spans]), speaker)
                       for speaker, spans in by_speaker.items()), reverse=True)
    if not coverage or coverage[0][0] / length < MIN_COVERAGE:
        return None
    # A word crossing a speaker boundary is uncertain too, even without overlap.
    conflict = max(MIN_CONFLICT_SECONDS, length * 0.1)
    if len(coverage) > 1 and coverage[1][0] >= conflict:
        return None
    best = coverage[0][1]
    if not any(turn_length >= MIN_TURN_SECONDS for _, _, turn_length in by_speaker[best]):
        return None
    return best


def overlapping_intervals(turns):
    events = []
    for a, b, speaker in turns:
        events.extend(((a, 1, speaker), (b, -1, speaker)))
    active, intervals, previous = {}, [], None
    for time, change, speaker in sorted(events):
        if previous is not None and time > previous and len(active) > 1:
            if intervals and intervals[-1][1] == previous:
                intervals[-1] = (intervals[-1][0], time)
            else:
                intervals.append((previous, time))
        active[speaker] = active.get(speaker, 0) + change
        if not active[speaker]:
            del active[speaker]
        previous = time
    return intervals


def diarize_segments(segments, turns, duration):
    turns = normalize_turns(turns, duration)
    names = {}
    for _, _, speaker in turns:
        names.setdefault(speaker, f"SPEAKER_{len(names):02d}")
    output, uncertain = [], 0
    cursor, active = 0, []
    for segment in segments:
        # Without word times, never invent the text on either side of a change.
        units = segment.get("words") or [segment]
        for unit in units:
            start, end = unit["start"], unit["end"]
            active = [turn for turn in active if turn[1] > start]
            while cursor < len(turns) and turns[cursor][0] < end:
                if turns[cursor][1] > start:
                    active.append(turns[cursor])
                cursor += 1
            name = speaker_for(start, end, active)
            speaker = names.get(name)
            if speaker is None:
                uncertain += 1
            text = unit.get("word", " " + unit.get("text", ""))
            if output and output[-1]["speaker"] == speaker and 0 <= start - output[-1]["end"] < 2:
                output[-1]["text"] += text
                output[-1]["end"] = end
            else:
                output.append({"start": start, "end": end, "text": text, "speaker": speaker})
    for item in output:
        item["text"] = item["text"].strip()
    warnings = []
    overlaps = overlapping_intervals(turns)
    short = [(a, b) for a, b, _ in turns if b - a < MIN_TURN_SECONDS]
    if overlaps:
        warnings.append({"code": "overlapping_speech", "count": len(overlaps), "duration": round(union_duration(overlaps), 3)})
    if short:
        warnings.append({"code": "short_turns", "count": len(short), "duration": round(union_duration(short), 3)})
    if uncertain:
        warnings.append({"code": "uncertain_assignment", "count": uncertain})
    if not turns:
        warnings.append({"code": "no_speakers_detected", "count": 1})
    return output, {"state": "ready", "speakerCount": len(names), "identitiesKnown": False, "warnings": warnings}


def attach_speakers(segments, turns):
    duration = max([s.get("end", 0) for s in segments] + [b for _, b, _ in turns] + [0])
    return diarize_segments(segments, turns, duration)[0]
