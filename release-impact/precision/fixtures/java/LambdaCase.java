import java.util.function.IntUnaryOperator;

public class LambdaCase {

    public int viaLambda(int base) {
        IntUnaryOperator op = v -> {
            if (v < 0) {
                return -1;
            }
            return v + base;
        };
        int out = op.applyAsInt(base);
        return out;
    }
}
