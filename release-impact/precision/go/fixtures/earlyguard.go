package main

func earlyGuard(err error, n int) (int, error) {
	if err != nil {
		return 0, err
	}
	total := n + 1
	return total, nil
}
