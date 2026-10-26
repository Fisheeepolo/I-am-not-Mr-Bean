import math,unittest,json
from pathlib import Path
import numpy as np
from metrics import components,edge_scores,area_reference,delta,reference_saliency

class MetricsTests(unittest.TestCase):
    def test_islands_denominator(self):
        m=components(np.array([[0,1,-1],[0,2,2]]))
        self.assertEqual(m['tinyCells'],5);self.assertEqual(m['nonempty'],5);self.assertEqual(m['speckleRatio'],1)
    def test_four_not_eight_connectivity(self):
        m=components(np.array([[0,-1],[-1,0]]));self.assertEqual(m['componentCount'],2)
    def test_grid_perimeter_singleton(self):
        self.assertAlmostEqual(components(np.array([[0]]))['compactnessMean'],4/math.pi)
    def test_grid_perimeter_rectangle(self):
        self.assertAlmostEqual(components(np.zeros((2,3),int))['compactnessMean'],100/(24*math.pi))
    def test_hole_perimeter(self):
        a=np.zeros((3,3),int);a[1,1]=-1
        self.assertAlmostEqual(components(a)['compactnessMean'],16**2/(32*math.pi))
    def test_exact_and_tolerant_edges(self):
        r=np.zeros((12,12),bool);p=r.copy();r[3,3]=1;p[3,7]=1
        self.assertEqual(edge_scores(r,p,0)['f1'],0);self.assertEqual(edge_scores(r,p,4)['f1'],1)
    def test_empty_edge_conventions(self):
        r=np.zeros((3,3),bool);p=r.copy();self.assertEqual(edge_scores(r,p,0)['f1'],1);p[0,0]=1;self.assertEqual(edge_scores(r,p,0)['f1'],0)
    def test_alpha_area_hidden_rgb(self):
        raw=np.array([[[255,0,0,0],[255,255,255,255]],[[255,0,0,0],[255,255,255,255]]],np.uint8)
        rgb,mask=area_reference(raw,1,1);np.testing.assert_array_equal(rgb,[[[255,255,255]]]);self.assertTrue(mask[0,0])
    def test_de2000_published_pair(self):
        self.assertAlmostEqual(float(delta(np.array([50.,2.6772,-79.7751]),np.array([50.,0.,-82.7485]))),2.0425,places=4)
    def test_original_islands_not_hidden_by_exemption(self):
        m=components(np.array([[0,1,1],[1,1,1]]),marker_positions=[(0,0)])
        self.assertEqual(m['tinyCells'],1);self.assertEqual(m['referenceSalientTinyCells'],1);self.assertEqual(m['nonExemptTinyCells'],0)
    def test_reference_saliency_uniform_zero(self):
        r=np.full((32,32,4),255,np.uint8);self.assertLess(float(reference_saliency(r,8,8).max()),1e-10)
    def test_reference_saliency_finite_bounded(self):
        r=np.full((32,32,4),255,np.uint8);r[14:18,14:18,:3]=0;s=reference_saliency(r,8,8)
        self.assertTrue(np.isfinite(s).all());self.assertGreater(s.max(),0);self.assertGreaterEqual(s.min(),0);self.assertLessEqual(s.max(),1)
    def test_marker_background_really_matches_source(self):
        root=Path(__file__).parent
        for f in json.loads((root/'fixtures.json').read_text('utf8')):
            raw=np.frombuffer((root/f['source']).read_bytes(),np.uint8).reshape(f['sourceHeight'],f['sourceWidth'],4)
            ref,_=area_reference(raw,f['width'],f['height'])
            for m in f['markers']:
                x,y=m['backgroundPoint'];np.testing.assert_allclose(ref[y,x],m['backgroundRgb'],atol=0,err_msg=f['id']+' '+m['name'])

if __name__=='__main__':unittest.main()
