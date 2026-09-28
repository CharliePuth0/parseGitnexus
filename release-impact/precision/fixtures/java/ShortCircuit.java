public class ShortCircuit {

    public boolean shortCircuit(String key, boolean flag) {
        boolean valid = key != null && key.length() > 2;
        boolean blocked = flag && valid;
        return blocked || !flag;
    }
}
