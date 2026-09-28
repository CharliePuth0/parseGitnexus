public class NestedIf {

    public String classify(int score, boolean active) {
        String label = "none";
        if (score > 50) {
            if (active) {
                label = "hot";
            } else {
                label = "warm";
            }
        }
        return label;
    }
}
