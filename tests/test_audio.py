"""Run: python3 -m unittest discover -s tests -p test_audio.py -v"""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/ffmpeg/linux/audio.sh'


class AudioCommand(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.source = self.directory / '-sample: video.mp4'
        subprocess.run([
            'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=black:s=64x64:r=10:d=2', '-f', 'lavfi', '-i',
            'sine=frequency=440:duration=2', '-c:v', 'libx264', '-c:a', 'aac',
            '-shortest', str(self.source),
        ], check=True)

    def audio(self, *args):
        return subprocess.run(['bash', str(SCRIPT), *args], cwd=self.directory,
                              capture_output=True, text=True)

    def probe(self, output):
        return json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_streams', '-show_format',
            '-of', 'json', str(output),
        ], text=True))

    def test_default_output_and_no_overwrite(self):
        result = self.audio(self.source.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.directory / '-sample: video_audio.mp3'
        meta = self.probe(output)
        self.assertEqual([s['codec_type'] for s in meta['streams']], ['audio'])
        self.assertEqual(meta['streams'][0]['codec_name'], 'mp3')
        original = output.read_bytes()
        result = self.audio(str(self.source))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_bytes(), original)

    def test_all_formats_and_time_range(self):
        for extension, codec in [('mp3', 'mp3'), ('m4a', 'aac'), ('aac', 'aac'),
                                 ('ogg', 'vorbis'), ('flac', 'flac'), ('wav', 'pcm_s16le')]:
            with self.subTest(format=extension):
                output = self.directory / ('clip.' + extension)
                result = self.audio(str(self.source), str(output), '--start', '0.5', '--end', '1.5')
                self.assertEqual(result.returncode, 0, result.stderr)
                meta = self.probe(output)
                self.assertEqual(meta['streams'][0]['codec_name'], codec)
                self.assertEqual(len(meta['streams']), 1)
                self.assertAlmostEqual(float(meta['format']['duration']), 1, delta=0.12)

    def test_sourced_function_and_explicit_format(self):
        result = subprocess.run([
            'bash', '-c', 'source "$1"; audio "$2" --format wav',
            'bash', str(SCRIPT), str(self.source),
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.directory / '-sample: video_audio.wav'
        self.assertEqual(self.probe(output)['streams'][0]['sample_rate'], '48000')

    def test_invalid_arguments_leave_input_unchanged(self):
        original = self.source.read_bytes()
        for args in [('--start', '-1'), ('--start', 'oops'), ('--end', '0'),
                     ('--start', '1', '--end', '0.5'), ('--format', 'xyz'),
                     ('--format',), ('--unknown',), ('out.mp3', '--format', 'wav'),
                     (str(self.source),), ('missing/out.mp3',)]:
            with self.subTest(args=args):
                result = self.audio(str(self.source), *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.source.read_bytes(), original)
                self.assertEqual(list(self.directory.glob('*.mp3')), [])


if __name__ == '__main__':
    unittest.main()
