"""Run with python3 -m unittest discover -s tests -v (requires ffmpeg/ffprobe)."""
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/ffmpeg/linux/cut.sh'


class RipTimeValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / 'sample video.mp4'
        subprocess.run([
            'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=black:s=64x64:r=10:d=2', '-c:v', 'libx264',
            str(self.source),
        ], check=True)

    def rip(self, start, end, source=None):
        return subprocess.run(
            ['bash', str(SCRIPT), str(source or self.source), start, end],
            capture_output=True, text=True,
        )

    def test_invalid_ranges_do_not_create_output(self):
        for start, end in [
            ('-1', '1'), ('nope', '1'), ('0', '00:60'), ('0', '00:60:00'),
            ('0', '1:2:3:4'), ('0', '1.'), ('0', ''), ('0', r'1\062'),
            ('1', '1'), ('1.5', '1'), ('2', '3'), ('0', '2.001'),
            ('01:39:26', '01:40:10'),
        ]:
            with self.subTest(start=start, end=end):
                result = self.rip(start, end)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('错误:', result.stderr)
                self.assertEqual(list(self.directory.glob('*_cut_*')), [])

    def test_valid_formats_and_end_at_duration(self):
        for start, end in [('0', '2'), ('0.50', '1.500'), ('00:00.5', '00:01.5'), ('00:00:00.5', '00:00:01.5')]:
            with self.subTest(start=start, end=end):
                result = self.rip(start, end)
                self.assertEqual(result.returncode, 0, result.stderr)
                name = '000000-000002' if start == '0' else '000000.5-000001.5'
                output = self.directory / f'sample video_cut_{name}.mp4'
                duration = subprocess.check_output([
                    'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1', str(output),
                ], text=True)
                self.assertAlmostEqual(float(duration), 2 if start == '0' else 1, places=2)

    def test_filename_normalizes_minutes_hours_and_bitrate(self):
        for start, end, label in [
            ('90', '225', '000130-000345'),
            ('59.50', '3600.25', '000059.5-010000.25'),
            ('90:00', '100:00:00', '013000-1000000'),
        ]:
            with self.subTest(start=start, end=end):
                result = subprocess.run([
                    'bash', '-c',
                    'source "$1"; ffprobe() { echo 400000; }; '
                    'ffmpeg() { touch "${@: -1}"; }; rip "$2" "$3" "$4" 2M',
                    'test', str(SCRIPT), str(self.source), start, end,
                ], capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = self.directory / f'sample video_cut_{label}_2M.mp4'
                self.assertTrue(output.is_file(), result.stdout)
                output.unlink()

    def test_non_mp4_inputs_produce_mp4(self):
        for extension in ('mkv', 'mov'):
            with self.subTest(extension=extension):
                source = self.directory / f'sample video.{extension}'
                subprocess.run([
                    'ffmpeg', '-v', 'error', '-i', str(self.source),
                    '-c', 'copy', str(source),
                ], check=True)
                result = self.rip('0', '1', source=source)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = self.directory / 'sample video_cut_000000-000001.mp4'
                self.assertEqual(list(self.directory.glob('*_cut_*')), [output])
                format_name = subprocess.check_output([
                    'ffprobe', '-v', 'error', '-show_entries', 'format=format_name',
                    '-of', 'default=noprint_wrappers=1:nokey=1', str(output),
                ], text=True).strip()
                self.assertIn('mp4', format_name.split(','))
                output.unlink()

    def test_unreadable_media_is_rejected(self):
        bad = self.directory / 'bad.mp4'
        bad.write_text('not a video')
        result = self.rip('0', '1', source=bad)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('无法读取素材时长', result.stderr)
        self.assertEqual(list(self.directory.glob('*_cut_*')), [])

    def test_unavailable_duration_and_probe_failure_stop_before_encoding(self):
        for duration, exit_code in [('N/A', 0), ('0', 0), ('NaN', 0), ('2', 1)]:
            with self.subTest(duration=duration, exit_code=exit_code):
                result = subprocess.run([
                    'bash', '-c',
                    'source "$1"; probe_duration="$3"; probe_code="$4"; '
                    'ffprobe() { echo "$probe_duration"; return "$probe_code"; }; '
                    'ffmpeg() { echo ENCODER_STARTED; }; rip "$2" 0 1',
                    'test', str(SCRIPT), str(self.source), duration, str(exit_code),
                ], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('ENCODER_STARTED', result.stdout)


if __name__ == '__main__':
    unittest.main()
